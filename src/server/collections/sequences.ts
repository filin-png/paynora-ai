import type { CollectionSequence, CollectionStopReason } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";
import { CollectionsResourceNotFoundError, InvalidSequenceTransitionError } from "./errors";

export async function getCollectionSequenceForInvoice(organizationId: string, invoiceId: string) {
  return prisma.collectionSequence.findFirst({ where: { organizationId, invoiceId } });
}

export async function listActiveCollectionSequences(organizationId: string) {
  return prisma.collectionSequence.findMany({
    where: { organizationId, status: { in: ["ACTIVE", "PAUSED"] } },
    include: { invoice: true, customer: true, policy: true },
    orderBy: { createdAt: "desc" },
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
  const result = await prisma.collectionSequence.updateMany({
    where: { id: sequenceId, organizationId, status: "ACTIVE" },
    data: { status: "PAUSED", pausedAt: new Date() },
  });
  if (result.count === 1) {
    const updated = await prisma.collectionSequence.findUniqueOrThrow({ where: { id: sequenceId } });
    await recordActivityEvent(prisma, {
      organizationId,
      type: "COLLECTION_SEQUENCE_PAUSED",
      summary: "Collections sequence paused",
      invoiceId: updated.invoiceId,
      customerId: updated.customerId,
    });
    return updated;
  }
  return resolveNonTransition(organizationId, sequenceId, "PAUSED", "pause");
}

/**
 * Resuming never bursts stale reminders: it only flips status back to
 * ACTIVE. It does NOT retroactively execute any step whose daysAfterDue
 * already passed while paused — the next tick's normal catch-up logic
 * (src/server/collections/engine.ts) decides what, if anything, is still
 * due, using the same single-most-advanced-step rule as any other
 * catch-up gap. See docs/collections-automation.md#catch-up.
 */
export async function resumeCollectionSequence(
  organizationId: string,
  sequenceId: string,
): Promise<CollectionSequence> {
  const result = await prisma.collectionSequence.updateMany({
    where: { id: sequenceId, organizationId, status: "PAUSED" },
    data: { status: "ACTIVE", pausedAt: null },
  });
  if (result.count === 1) {
    const updated = await prisma.collectionSequence.findUniqueOrThrow({ where: { id: sequenceId } });
    await recordActivityEvent(prisma, {
      organizationId,
      type: "COLLECTION_SEQUENCE_RESUMED",
      summary: "Collections sequence resumed",
      invoiceId: updated.invoiceId,
      customerId: updated.customerId,
    });
    return updated;
  }
  return resolveNonTransition(organizationId, sequenceId, "ACTIVE", "resume");
}

export async function stopCollectionSequenceManually(
  organizationId: string,
  sequenceId: string,
): Promise<CollectionSequence> {
  const result = await prisma.collectionSequence.updateMany({
    where: { id: sequenceId, organizationId, status: { in: ["ACTIVE", "PAUSED"] } },
    data: { status: "STOPPED", stopReason: "MANUAL", stoppedAt: new Date() },
  });
  if (result.count === 1) {
    const updated = await prisma.collectionSequence.findUniqueOrThrow({ where: { id: sequenceId } });
    await recordActivityEvent(prisma, {
      organizationId,
      type: "COLLECTION_SEQUENCE_STOPPED",
      summary: "Collections sequence stopped manually",
      invoiceId: updated.invoiceId,
      customerId: updated.customerId,
    });
    return updated;
  }
  return resolveNonTransition(organizationId, sequenceId, "STOPPED", "stop");
}

async function resolveNonTransition(
  organizationId: string,
  sequenceId: string,
  idempotentTargetStatus: CollectionSequence["status"],
  action: string,
): Promise<CollectionSequence> {
  const current = await prisma.collectionSequence.findFirst({ where: { id: sequenceId, organizationId } });
  if (!current) throw new CollectionsResourceNotFoundError("Collection sequence");
  if (current.status === idempotentTargetStatus) return current;
  throw new InvalidSequenceTransitionError(current.status, action);
}

export type CollectionStatusView =
  | { kind: "not_enrolled" }
  | { kind: "completed"; stopReason: CollectionStopReason | null }
  | { kind: "stopped"; stopReason: CollectionStopReason | null }
  | { kind: "paused" }
  | { kind: "blocked_uncertain" }
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
  if (sequence.status === "PAUSED") return { kind: "paused" };

  const blockingCommunication = await prisma.communication.findFirst({
    where: { invoiceId, status: { in: ["SENDING", "UNCERTAIN"] } },
  });
  if (blockingCommunication) return { kind: "blocked_uncertain" };

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
