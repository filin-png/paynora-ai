import { Prisma, type BusinessEvent, type CollectionPolicyStep, type CollectionSequence } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";

export class CollectionClaimLostError extends Error {}

/** Every collection artifact writer and the recovery worker fence on the same row. */
export async function lockCollectionClaim(
  tx: Prisma.TransactionClient,
  organizationId: string,
  executionId: string,
  staleBefore?: Date,
): Promise<boolean> {
  const eligibility = staleBefore
    ? Prisma.sql`AND "claimedAt" <= ${staleBefore}`
    : Prisma.sql`AND "completedAt" IS NULL`;
  const lock = staleBefore ? Prisma.sql`FOR UPDATE SKIP LOCKED` : Prisma.sql`FOR UPDATE`;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM collection_step_executions
    WHERE id = ${executionId} AND "organizationId" = ${organizationId}
      AND status = 'CLAIMED' AND note IS NULL
    ${eligibility}
    ${lock}
  `;
  return rows.length === 1;
}

export function writeWithCollectionClaim<T>(
  organizationId: string,
  executionId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockCollectionClaim(tx, organizationId, executionId))) throw new CollectionClaimLostError();
    return write(tx);
  });
}

export function collectionStepEventKey(organizationId: string, executionId: string) {
  return { organizationId, type: "COLLECTION_STEP_DUE" as const, dedupeKey: executionId };
}

export function eventMatchesStep(event: BusinessEvent, sequence: CollectionSequence, step: CollectionPolicyStep) {
  const { data } = event;
  return event.organizationId === sequence.organizationId &&
    event.invoiceId === sequence.invoiceId && event.customerId === sequence.customerId &&
    data !== null && typeof data === "object" && !Array.isArray(data) && data.stepAction === step.action;
}

export async function completeCollectionClaim(
  tx: Prisma.TransactionClient,
  sequence: CollectionSequence,
  step: CollectionPolicyStep,
  executionId: string,
  businessEventId: string,
  actionProposalId: string,
  recovery?: { delivery: "none" | "draft" | "sent"; insightCreated: boolean; proposalCreated: boolean },
): Promise<boolean> {
  const transition = await tx.collectionStepExecution.updateMany({
    where: { id: executionId, organizationId: sequence.organizationId, status: "CLAIMED", note: null, completedAt: null },
    data: { status: "EXECUTED", businessEventId, actionProposalId, completedAt: new Date() },
  });
  if (transition.count !== 1) return false;

  await recordActivityEvent(tx, {
    organizationId: sequence.organizationId,
    type: "COLLECTION_STEP_EXECUTED",
    summary: recovery
      ? "Collections step recovered from persisted records"
      : `Collection step executed (day ${step.daysAfterDue}, ${step.action})`,
    invoiceId: sequence.invoiceId,
    customerId: sequence.customerId,
    metadata: recovery ? { executionId, sequenceId: sequence.id, recovery: { outcome: "recovered", ...recovery } } : undefined,
  });
  return true;
}
