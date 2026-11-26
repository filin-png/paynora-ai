import type { ActionProposal, CollectionPolicyStep, CollectionSequence, Prisma } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { daysBetween, toDateOnlyString } from "@/server/ar/dates";
import { getInvoiceWithFinancials } from "@/server/ar/invoices";
import {
  assessDelivery, deliveryHistorySelect, findBlockedDeliveryInvoices, lockDeliveryCommunication, lockDeliveryInvoice, resolutionChain,
} from "@/server/communications/delivery-guard";
import { formatDeterministicInvoiceContext } from "@/server/ar/reminder-context";
import { prisma } from "@/server/db/client";
import { buildInvoiceOverdueInsightData } from "@/server/operator/insights";
import { buildReminderProposalData } from "@/server/operator/proposals";
import { collectionStepEventKey, completeCollectionClaim, eventMatchesStep, lockCollectionClaim } from "./execution";

const CLAIM_STALE_AFTER_MS = 30 * 60 * 1000;
const RECOVERY_BATCH_SIZE = 25;
const REVIEW_NOTE = "Manual recovery review required";

type RecoveryResult = "unchanged" | "recovered" | "manual_review";
type DeliveryEvidence = "none" | "draft" | "sent";
type ReviewReason =
  | "CLAIM_OR_SEQUENCE_MISMATCH"
  | "UNSUPPORTED_ACTION"
  | "BUSINESS_EVENT_MISSING"
  | "BUSINESS_EVENT_MISMATCH"
  | "INSIGHT_OR_PROPOSAL_MISMATCH"
  | "DELIVERY_UNKNOWN"
  | "DELIVERY_UNPROVEN"
  | "REMINDER_NO_LONGER_ELIGIBLE"
  | "OTHER_DELIVERY_PENDING"
  | "OTHER_CLAIM_UNRESOLVED"
  | "LATER_STEP_DUE";

export async function recoverStaleCollectionClaims(organizationId: string, now: Date, today: string) {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_AFTER_MS);
  const candidates = await prisma.collectionStepExecution.findMany({
    where: { organizationId, status: "CLAIMED", note: null, claimedAt: { lte: staleBefore } },
    orderBy: [{ claimedAt: "asc" }, { id: "asc" }],
    take: RECOVERY_BATCH_SIZE,
    select: { id: true, sequenceId: true },
  });

  const recoveredSequences = new Set<string>();
  let recovered = 0;
  let needsReview = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await prisma.$transaction((tx) => recoverClaim(tx, organizationId, candidate.id, staleBefore, today));
      if (result === "recovered") {
        recoveredSequences.add(candidate.sequenceId);
        recovered += 1;
      }
      if (result === "manual_review") needsReview += 1;
    } catch (error) {
      failed += 1;
      console.error(`[automation] collection recovery failed organizationId=${organizationId} executionId=${candidate.id}`, error);
    }
  }
  return { recovered, needsReview, failed, recoveredSequences };
}

async function recoverClaim(
  tx: Prisma.TransactionClient,
  organizationId: string,
  executionId: string,
  staleBefore: Date,
  today: string,
): Promise<RecoveryResult> {
  if (!(await lockCollectionClaim(tx, organizationId, executionId, staleBefore))) return "unchanged";
  const claim = await tx.collectionStepExecution.findUniqueOrThrow({
    where: { id: executionId },
    include: {
      step: true,
      sequence: {
        include: {
          invoice: { select: { organizationId: true, customerId: true } },
          customer: { select: { organizationId: true } },
        },
      },
    },
  });
  const { sequence, step } = claim;
  const sameScope = sequence.organizationId === organizationId &&
    sequence.invoice.organizationId === organizationId && sequence.invoice.customerId === sequence.customerId &&
    sequence.customer.organizationId === organizationId;
  const review = async (reason: ReviewReason): Promise<RecoveryResult> => {
    await tx.collectionStepExecution.update({
      where: { id: claim.id },
      data: { note: `${REVIEW_NOTE}: ${reason}` },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "COLLECTION_STEP_SKIPPED",
      summary: "Automatic collection recovery skipped. Manual review required.",
      invoiceId: sameScope ? sequence.invoiceId : undefined,
      customerId: sameScope ? sequence.customerId : undefined,
      metadata: { executionId, sequenceId: sequence.id, recovery: { outcome: "manual_review", reason, status: "CLAIMED" } },
    });
    return "manual_review";
  };
  if (!sameScope || claim.completedAt || step.policyId !== sequence.policyId || step.version !== sequence.policyVersion) {
    return review("CLAIM_OR_SEQUENCE_MISMATCH");
  }
  if (step.action !== "SEND_PAYMENT_REMINDER") return review("UNSUPPORTED_ACTION");

  const event = await tx.businessEvent.findUnique({
    where: { organizationId_type_dedupeKey: collectionStepEventKey(organizationId, executionId) },
    include: {
      collectionStepExecution: { select: { id: true } },
      insights: {
        take: 2,
        include: { proposals: { take: 2, include: { collectionStepExecution: { select: { id: true } } } } },
      },
    },
  });
  if (!event) return review("BUSINESS_EVENT_MISSING");
  if (!eventMatchesStep(event, sequence, step) ||
    (claim.businessEventId && claim.businessEventId !== event.id) ||
    (event.collectionStepExecution && event.collectionStepExecution.id !== executionId)) {
    return review("BUSINESS_EVENT_MISMATCH");
  }

  const [insight] = event.insights;
  const [proposal] = insight?.proposals ?? [];
  const matchesScope = (row: { organizationId: string; invoiceId: string | null; customerId: string | null }) =>
    row.organizationId === organizationId && row.invoiceId === sequence.invoiceId && row.customerId === sequence.customerId;
  if (event.insights.length > 1 ||
    (insight && (!matchesScope(insight) || insight.proposals.length > 1)) ||
    (proposal && (!matchesScope(proposal) || proposal.type !== "SEND_PAYMENT_REMINDER")) ||
    (proposal?.collectionStepExecution && proposal.collectionStepExecution.id !== executionId) ||
    (claim.actionProposalId && claim.actionProposalId !== proposal?.id)) {
    return review("INSIGHT_OR_PROPOSAL_MISMATCH");
  }

  let finalProposalId: string;
  let delivery: DeliveryEvidence = "none";
  if (proposal) {
    const evidence = await inspectProposalDelivery(tx, proposal, sequence);
    if (evidence === "DELIVERY_UNKNOWN" || evidence === "DELIVERY_UNPROVEN") return review(evidence);
    delivery = evidence;
    finalProposalId = proposal.id;
  } else {
    const result = await contextForMissingProposal(tx, sequence, step, executionId, today);
    if (typeof result === "string") return review(result);
    const finalInsight = insight ?? await tx.operatorInsight.create({
      data: buildInvoiceOverdueInsightData(organizationId, event, result),
    });
    const created = await tx.actionProposal.create({
      data: buildReminderProposalData(organizationId, finalInsight, step.tone.toLowerCase()),
    });
    finalProposalId = created.id;
  }

  // The locked row is still ours. If finalization unexpectedly fails, roll
  // back any new insight/proposal together with the attempted transition.
  if (!(await completeCollectionClaim(tx, sequence, step, executionId, event.id, finalProposalId, {
    delivery, insightCreated: !insight, proposalCreated: !proposal,
  }))) throw new Error("Locked collection claim could not be finalized");
  return "recovered";
}

async function inspectProposalDelivery(
  tx: Prisma.TransactionClient,
  proposal: ActionProposal,
  sequence: CollectionSequence,
): Promise<DeliveryEvidence | "DELIVERY_UNKNOWN" | "DELIVERY_UNPROVEN"> {
  const candidate = await tx.communication.findUnique({
    where: { actionProposalId: proposal.id },
    select: { id: true, organizationId: true, invoiceId: true, customerId: true },
  });
  if (candidate && (candidate.organizationId !== sequence.organizationId ||
    candidate.invoiceId !== sequence.invoiceId || candidate.customerId !== sequence.customerId)) return "DELIVERY_UNPROVEN";
  if (candidate) await lockDeliveryCommunication(tx, sequence.organizationId, candidate.id);
  const currentProposal = await tx.actionProposal.findUniqueOrThrow({ where: { id: proposal.id }, select: { status: true } });
  if (!candidate) {
    return ["PENDING", "APPROVED", "DISMISSED", "STALE"].includes(currentProposal.status) ? "none" : "DELIVERY_UNPROVEN";
  }

  const communication = await tx.communication.findFirstOrThrow({
    where: { id: candidate.id, organizationId: sequence.organizationId },
    select: deliveryHistorySelect,
  });
  if (communication.purpose !== "PAYMENT_REMINDER") return "DELIVERY_UNPROVEN";
  const block = assessDelivery(communication);
  if (block === "unknown" || block === "frozen" || block === "in_progress") return "DELIVERY_UNKNOWN";
  if (communication.status === "DRAFT" && currentProposal.status === "APPROVED" && !block &&
    !communication.sentAt && communication.deliveryAttempts.length === 0) return "draft";
  const recordedSend = communication.status === "SENT" && currentProposal.status === "EXECUTED" &&
    communication.sentAt && communication.deliveryAttempts.some((attempt) => attempt.status === "SUCCESS" && attempt.completedAt);
  const resolvedDelivery = ["APPROVED", "EXECUTED"].includes(currentProposal.status) &&
    communication.deliveryAttempts.some((attempt) => resolutionChain(attempt).head?.decision === "CONFIRMED_DELIVERED");
  return block === "sent" && (recordedSend || resolvedDelivery) ? "sent" : "DELIVERY_UNPROVEN";
}

async function contextForMissingProposal(
  tx: Prisma.TransactionClient,
  sequence: CollectionSequence,
  step: CollectionPolicyStep,
  executionId: string,
  today: string,
) {
  const { organizationId, invoiceId } = sequence;
  await tx.$queryRaw`SELECT id FROM collection_sequences WHERE id = ${sequence.id} AND "organizationId" = ${organizationId} FOR SHARE`;
  const active = await tx.collectionSequence.findFirst({
    where: {
      id: sequence.id, organizationId, status: "ACTIVE",
      organization: { automationEnabled: true }, policy: { organizationId, enabled: true },
    },
    select: { id: true },
  });
  if (!active) return "REMINDER_NO_LONGER_ELIGIBLE";

  const otherClaim = await tx.collectionStepExecution.findFirst({
    where: { organizationId, sequenceId: sequence.id, status: "CLAIMED", id: { not: executionId } },
    select: { id: true },
  });
  if (otherClaim) return "OTHER_CLAIM_UNRESOLVED";

  await lockDeliveryInvoice(tx, organizationId, invoiceId);
  const entry = await getInvoiceWithFinancials(organizationId, invoiceId, today, tx);
  const daysOverdue = daysBetween(toDateOnlyString(entry.invoice.dueDate), today);
  if (!entry.financials.isOverdue || entry.invoice.customer.archivedAt || daysOverdue < step.daysAfterDue) {
    return "REMINDER_NO_LONGER_ELIGIBLE";
  }

  const laterStep = await tx.collectionPolicyStep.findFirst({
    where: {
      policyId: sequence.policyId, version: sequence.policyVersion,
      daysAfterDue: { gt: step.daysAfterDue, lte: daysOverdue },
    },
    select: { id: true },
  });
  if (laterStep) return "LATER_STEP_DUE";

  const blocked = await findBlockedDeliveryInvoices(tx, organizationId, [invoiceId], undefined, true);
  return blocked.size ? "OTHER_DELIVERY_PENDING" : formatDeterministicInvoiceContext(entry, today);
}
