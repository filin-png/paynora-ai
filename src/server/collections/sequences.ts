import type { CollectionSequence, CollectionStopReason, Prisma } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";
import { findBlockedDeliveryInvoices } from "@/server/communications/delivery-guard";
import { CollectionsResourceNotFoundError, InvalidSequenceTransitionError } from "./errors";

export async function getCollectionSequenceForInvoice(organizationId: string, invoiceId: string) {
  return prisma.collectionSequence.findFirst({ where: { organizationId, invoiceId } });
}

const ACTIVE_SEQUENCES_LIMIT = 500;

/** Only consumed by the automation UI page — the automation tick engine (src/server/collections/engine.ts) queries active sequences itself and must never be capped here. */
export async function listActiveCollectionSequences(organizationId: string) {
  return prisma.collectionSequence.findMany({
    where: { organizationId, status: { in: ["ACTIVE", "PAUSED"] } },
    include: { invoice: true, customer: true, policy: true },
    orderBy: { createdAt: "desc" },
    // Defensive cap, not real pagination — see
    // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P2-3. Active sequences
    // are naturally self-limiting (they leave this list on completion or
    // manual stop); this only guards a badly neglected organization.
    take: ACTIVE_SEQUENCES_LIMIT,
  });
}

/**
 * OWNER-only enforcement happens at the caller (Server Action / route
 * handler), same layering as src/server/collections/policy.ts. Pausing
 * only ever transitions from ACTIVE via an atomic conditional `updateMany`
 * — the same compare-and-swap technique as
 * src/server/operator/approval.ts's transitionActionProposal — so a pause
 * racing a worker's claim (section 28/PAUSE-vs-WORKER) resolves cleanly:
 * whichever commits first wins, and the loser sees the row's new state
 * before acting on it.
 */
export async function pauseCollectionSequence(
  organizationId: string,
  sequenceId: string,
): Promise<CollectionSequence> {
  return transitionSequence(organizationId, sequenceId, {
    from: ["ACTIVE"],
    target: "PAUSED",
    data: { pausedAt: new Date() },
    action: "pause",
    auditType: "COLLECTION_SEQUENCE_PAUSED",
    summary: "Collections sequence paused",
  });
}

/** Catch-up on the next tick decides which step, if any, is still due. */
export async function resumeCollectionSequence(
  organizationId: string,
  sequenceId: string,
): Promise<CollectionSequence> {
  return transitionSequence(organizationId, sequenceId, {
    from: ["PAUSED"],
    target: "ACTIVE",
    data: { pausedAt: null },
    action: "resume",
    auditType: "COLLECTION_SEQUENCE_RESUMED",
    summary: "Collections sequence resumed",
  });
}

export async function stopCollectionSequenceManually(
  organizationId: string,
  sequenceId: string,
): Promise<CollectionSequence> {
  return transitionSequence(organizationId, sequenceId, {
    from: ["ACTIVE", "PAUSED"],
    target: "STOPPED",
    data: { stopReason: "MANUAL", stoppedAt: new Date() },
    action: "stop",
    auditType: "COLLECTION_SEQUENCE_STOPPED",
    summary: "Collections sequence stopped manually",
  });
}

async function transitionSequence(
  organizationId: string,
  sequenceId: string,
  transition: {
    from: CollectionSequence["status"][];
    target: CollectionSequence["status"];
    data: Pick<Prisma.CollectionSequenceUpdateManyMutationInput, "pausedAt" | "stoppedAt" | "stopReason">;
    action: "pause" | "resume" | "stop";
    auditType: "COLLECTION_SEQUENCE_PAUSED" | "COLLECTION_SEQUENCE_RESUMED" | "COLLECTION_SEQUENCE_STOPPED";
    summary: string;
  },
): Promise<CollectionSequence> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.collectionSequence.updateMany({
      where: { id: sequenceId, organizationId, status: { in: transition.from } },
      data: { ...transition.data, status: transition.target },
    });
    const current = await tx.collectionSequence.findFirst({ where: { id: sequenceId, organizationId } });
    if (!current) throw new CollectionsResourceNotFoundError("Collection sequence");
    if (result.count === 1) {
      await recordActivityEvent(tx, {
        organizationId,
        type: transition.auditType,
        summary: transition.summary,
        invoiceId: current.invoiceId,
        customerId: current.customerId,
      });
      return current;
    }
    if (current.status === transition.target) return current;
    throw new InvalidSequenceTransitionError(current.status, transition.action);
  });
}

export type CollectionStatusView =
  | { kind: "not_enrolled" }
  | { kind: "completed"; stopReason: CollectionStopReason | null }
  | { kind: "stopped"; stopReason: CollectionStopReason | null }
  | { kind: "paused"; sequenceId: string }
  | { kind: "blocked_uncertain"; sequenceId: string }
  | { kind: "active"; sequenceId: string; stepsCompleted: number; stepCount: number; nextStepDaysAfterDue?: number };

/**
 * Read-only status projection for the invoice detail page (see
 * docs/collections-automation.md#ui). Deliberately makes its own fresh
 * reads rather than caching anything — a page render should always show
 * what's true right now, not a stale snapshot. Unlike the automation
 * engine, this never claims, creates, or sends anything; the
 * SENDING/UNCERTAIN check here is purely informational (mirrors the
 * engine's own eligibility check in src/server/collections/engine.ts so
 * the UI and the engine never disagree about why nothing is happening).
 */
export async function getCollectionStatusForInvoice(
  organizationId: string,
  invoiceId: string,
): Promise<CollectionStatusView> {
  const sequence = await prisma.collectionSequence.findFirst({ where: { organizationId, invoiceId } });
  if (!sequence) return { kind: "not_enrolled" };
  if (sequence.status === "COMPLETED") return { kind: "completed", stopReason: sequence.stopReason };
  if (sequence.status === "STOPPED") return { kind: "stopped", stopReason: sequence.stopReason };
  if (sequence.status === "PAUSED") return { kind: "paused", sequenceId: sequence.id };

  const blockedInvoices = await findBlockedDeliveryInvoices(prisma, organizationId, [invoiceId]);
  if (blockedInvoices.has(invoiceId)) return { kind: "blocked_uncertain", sequenceId: sequence.id };

  const [steps, executions] = await Promise.all([
    prisma.collectionPolicyStep.findMany({
      where: { policyId: sequence.policyId, version: sequence.policyVersion },
      orderBy: { stepOrder: "asc" },
    }),
    prisma.collectionStepExecution.findMany({
      where: { sequenceId: sequence.id, status: "EXECUTED" },
      select: { stepId: true },
    }),
  ]);
  const executedStepIds = new Set(executions.map((execution) => execution.stepId));
  const stepsCompleted = steps.filter((step) => executedStepIds.has(step.id)).length;
  const nextStep = steps.find((step) => !executedStepIds.has(step.id));

  return {
    kind: "active",
    sequenceId: sequence.id,
    stepsCompleted,
    stepCount: steps.length,
    nextStepDaysAfterDue: nextStep?.daysAfterDue,
  };
}
