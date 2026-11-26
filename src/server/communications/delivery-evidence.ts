import { createHash } from "node:crypto";

import { z } from "zod";

export const deliveryEvidenceSchema = z.object({
  attemptKey: z.string().min(1).max(256),
  providerAccountRef: z.string().min(1).max(128),
  externalEventId: z.string().min(1).max(256).refine((value) => !value.startsWith("paynora-conflict:")),
  outcome: z.enum(["ACCEPTED", "DELIVERED", "NOT_DELIVERED", "INCONCLUSIVE"]),
  occurredAt: z.iso.datetime().optional(),
  providerReferenceHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export type DeliveryEvidenceInput = z.infer<typeof deliveryEvidenceSchema>;

export function deliveryEvidenceHash(input: DeliveryEvidenceInput) {
  return createHash("sha256").update(JSON.stringify([
    input.attemptKey, input.providerAccountRef, input.externalEventId, input.outcome,
    input.occurredAt ?? null, input.providerReferenceHash ?? null,
  ])).digest("hex");
}

export function assertSameDeliveryEvent(
  existing: { organizationId: string; communicationId: string; deliveryAttemptId: string; evidenceHash: string },
  incoming: typeof existing,
) {
  if (existing.evidenceHash !== incoming.evidenceHash || existing.organizationId !== incoming.organizationId ||
    existing.communicationId !== incoming.communicationId || existing.deliveryAttemptId !== incoming.deliveryAttemptId) {
    throw new DeliveryEventConflictError();
  }
}

export class DeliveryEventConflictError extends Error {
  constructor() {
    super("Delivery evidence conflicts with a previous event");
  }
}

export class DeliveryEvidenceUncorrelatedError extends Error {
  constructor() {
    super("Delivery evidence could not be associated with one attempt");
  }
}

/** A future adapter must authenticate the request and attest attempt/recipient correlation before returning evidence. */
export type DeliveryWebhookAdapter = { verify: (request: Request) => Promise<DeliveryEvidenceInput | null> };

export const deliveryWebhookAdapters: ReadonlyMap<string, DeliveryWebhookAdapter> = new Map();
