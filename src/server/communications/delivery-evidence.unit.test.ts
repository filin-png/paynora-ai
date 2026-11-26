import { describe, expect, it } from "vitest";

import { assertSameDeliveryEvent, deliveryEvidenceHash, deliveryEvidenceSchema, DeliveryEventConflictError } from "./delivery-evidence";

const input = {
  attemptKey: "attempt:1", providerAccountRef: "provider-fixture", externalEventId: "evt-1", outcome: "DELIVERED",
} as const;
const scope = { organizationId: "org", communicationId: "comm", deliveryAttemptId: "attempt" };
const event = { ...scope, evidenceHash: deliveryEvidenceHash(input) };

describe("delivery evidence", () => {
  it("accepts identical redelivery irrespective of object key order", () => {
    const replay = deliveryEvidenceSchema.parse({ outcome: input.outcome, externalEventId: input.externalEventId,
      providerAccountRef: input.providerAccountRef, attemptKey: input.attemptKey });
    expect(() => assertSameDeliveryEvent(event, { ...scope, evidenceHash: deliveryEvidenceHash(replay) })).not.toThrow();
  });

  it("rejects the same idempotency key with a different verified outcome", () => {
    const changed = { ...scope, evidenceHash: deliveryEvidenceHash({ ...input, outcome: "NOT_DELIVERED" }) };
    expect(() => assertSameDeliveryEvent(event, changed)).toThrow(DeliveryEventConflictError);
  });

  it.each(["organizationId", "communicationId", "deliveryAttemptId"] as const)("rejects a replay against a different %s", (key) => {
    expect(() => assertSameDeliveryEvent(event, { ...event, [key]: "different" })).toThrow(DeliveryEventConflictError);
  });

  it("rejects raw payload extras, missing event identity and an invalid timestamp", () => {
    expect(deliveryEvidenceSchema.safeParse({ ...input, recipient: "sensitive" }).success).toBe(false);
    expect(deliveryEvidenceSchema.safeParse({ ...input, externalEventId: "" }).success).toBe(false);
    expect(deliveryEvidenceSchema.safeParse({ ...input, occurredAt: "yesterday" }).success).toBe(false);
  });
});
