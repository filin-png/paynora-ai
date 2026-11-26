import { createHash, randomUUID } from "node:crypto";
import type { DeliveryAttempt, DeliveryEvidenceSource, Prisma } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";

import {
  assertSameDeliveryEvent, deliveryEvidenceHash, deliveryEvidenceSchema, DeliveryEventConflictError, DeliveryEvidenceUncorrelatedError,
  type DeliveryEvidenceInput,
} from "./delivery-evidence";
import { lockDeliveryCommunication } from "./delivery-guard";

type LockedCommunication = Awaited<ReturnType<typeof lockDeliveryCommunication>>;

async function appendEvidence(
  tx: Prisma.TransactionClient,
  communication: LockedCommunication,
  attempt: DeliveryAttempt,
  source: DeliveryEvidenceSource,
  input: DeliveryEvidenceInput,
) {
  const key = { provider: attempt.provider, providerAccountRef: input.providerAccountRef, source, externalEventId: input.externalEventId };
  const scope = {
    organizationId: attempt.organizationId,
    communicationId: attempt.communicationId,
    deliveryAttemptId: attempt.id,
    evidenceHash: deliveryEvidenceHash(input),
  };
  const { count } = await tx.deliveryProviderEvent.createMany({
    data: {
      ...key, ...scope, id: randomUUID(), outcome: input.outcome,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
      evidenceMetadata: input.providerReferenceHash ? { providerReferenceHash: input.providerReferenceHash } : undefined,
    },
    skipDuplicates: true,
  });
  const event = await tx.deliveryProviderEvent.findUniqueOrThrow({
    where: { provider_providerAccountRef_source_externalEventId: key },
  });
  const auditScope = { organizationId: attempt.organizationId, invoiceId: communication.invoiceId, customerId: communication.customerId };
  try {
    assertSameDeliveryEvent(event, scope);
  } catch (error) {
    if (!(error instanceof DeliveryEventConflictError)) throw error;
    // Keep the original evidence immutable. A contradictory reuse of its
    // identity is persisted separately and fails closed for the correlated attempt.
    const conflictKey = { ...key, externalEventId: `paynora-conflict:${createHash("sha256")
      .update(JSON.stringify([key.externalEventId, scope.deliveryAttemptId, scope.evidenceHash])).digest("hex")}` };
    const marker = await tx.deliveryProviderEvent.createMany({
      data: {
        ...conflictKey, ...scope, id: randomUUID(), outcome: "INCONCLUSIVE",
        evidenceMetadata: { idempotencyConflict: true },
      },
      skipDuplicates: true,
    });
    if (marker.count === 1) await recordActivityEvent(tx, {
      ...auditScope,
      type: "DELIVERY_PROVIDER_EVIDENCE_RECORDED",
      summary: "Conflicting delivery event identity requires review",
      metadata: { attemptId: attempt.id, conflict: true },
    });
    return { duplicate: false, incidentCreated: false, conflict: true };
  }
  if (count === 0) return { duplicate: true, incidentCreated: false, conflict: false };
  await recordActivityEvent(tx, {
    ...auditScope,
    type: "DELIVERY_PROVIDER_EVIDENCE_RECORDED",
    summary: "Verified delivery evidence recorded",
    metadata: { attemptId: attempt.id, evidenceEventId: event.id, outcome: event.outcome },
  });

  if (event.outcome !== "DELIVERED") return { duplicate: false, incidentCreated: false, conflict: false };
  const prior = await tx.deliveryResolution.findFirst({
    where: {
      organizationId: scope.organizationId, communicationId: scope.communicationId, deliveryAttemptId: scope.deliveryAttemptId,
      decision: "CONFIRMED_NOT_DELIVERED",
    },
    orderBy: { revision: "desc" },
  });
  if (!prior) return { duplicate: false, incidentCreated: false, conflict: false };

  const incident = await tx.deliveryIncident.create({
    data: {
      organizationId: scope.organizationId, communicationId: scope.communicationId, deliveryAttemptId: scope.deliveryAttemptId,
      providerEventId: event.id, priorResolutionId: prior.id, assignedOperatorId: prior.operatorId,
      description: "Verified late delivery contradicts an earlier non-delivery decision",
    },
  });
  await recordActivityEvent(tx, {
    ...auditScope,
    type: "DELIVERY_INCIDENT_OPENED",
    summary: "Delivery frozen after contradictory provider evidence",
    metadata: { attemptId: attempt.id, evidenceEventId: event.id, incidentId: incident.id },
  });
  return { duplicate: false, incidentCreated: true, conflict: false };
}

/** Only called after authentication by the selected adapter. Payload IDs never authorize account or tenant access. */
export async function recordVerifiedDeliveryWebhook(provider: string, payload: DeliveryEvidenceInput) {
  const input = deliveryEvidenceSchema.parse(payload);
  const candidate = await prisma.deliveryAttempt.findUnique({
    where: { idempotencyKey: input.attemptKey },
    select: { id: true, provider: true, providerAccountRef: true, organizationId: true, communicationId: true },
  });
  if (!candidate || candidate.provider !== provider || candidate.providerAccountRef !== input.providerAccountRef) {
    throw new DeliveryEvidenceUncorrelatedError();
  }
  const result = await prisma.$transaction(async (tx) => {
    const communication = await lockDeliveryCommunication(tx, candidate.organizationId, candidate.communicationId);
    const attempt = await tx.deliveryAttempt.findFirst({
      where: { id: candidate.id, organizationId: candidate.organizationId, communicationId: candidate.communicationId,
        provider, providerAccountRef: input.providerAccountRef, idempotencyKey: input.attemptKey },
    });
    if (!attempt) throw new DeliveryEvidenceUncorrelatedError();
    return appendEvidence(tx, communication, attempt, "WEBHOOK", input);
  }, { isolationLevel: "ReadCommitted" });
  if (result.conflict) throw new DeliveryEventConflictError();
  return { duplicate: result.duplicate, incidentCreated: result.incidentCreated };
}

/** The synchronous transport response proves acceptance only. Keep it even after reconciliation has won. */
export async function recordLateAcceptance(
  tx: Prisma.TransactionClient,
  communication: LockedCommunication,
  attempt: DeliveryAttempt,
  providerMessageId?: string,
) {
  await appendEvidence(tx, communication, attempt, "TRANSPORT", {
    attemptKey: attempt.idempotencyKey,
    providerAccountRef: attempt.providerAccountRef ?? `attempt:${attempt.id}`,
    externalEventId: `accepted:${attempt.id}`,
    outcome: "ACCEPTED",
    providerReferenceHash: providerMessageId ? createHash("sha256").update(providerMessageId).digest("hex") : undefined,
  });
}
