import { describe, expect, it } from "vitest";

import { assessDelivery, blocksInvoice, resolutionChain } from "./delivery-guard";

type Attempt = Parameters<typeof resolutionChain>[0];
const unknown = (): Attempt => ({ status: "UNKNOWN", providerEvents: [], resolutions: [], incidents: [] });
const failed: Attempt = { status: "FAILED", providerEvents: [], resolutions: [], incidents: [] };
const first = { id: "r1", revision: 1, supersedesId: null, decision: "CONFIRMED_NOT_DELIVERED", evidenceEventId: "proof" } as const;

function resolved(): Attempt {
  return {
    ...unknown(), resolutions: [first], providerEvents: [{ id: "proof", outcome: "NOT_DELIVERED" }],
  };
}

describe("Delivery Guard", () => {
  it.each([0, 1, 5])("blocks UNKNOWN before %d later failures", (count) => {
    expect(assessDelivery({ status: "FAILED", deliveryAttempts: [unknown(), ...Array<Attempt>(count).fill(failed)] })).toBe("unknown");
  });

  it("does not borrow evidence from another attempt", () => {
    expect(assessDelivery({ status: "UNCERTAIN", deliveryAttempts: [resolved(), unknown()] })).toBe("unknown");
    expect(assessDelivery({ status: "UNCERTAIN", deliveryAttempts: [resolved()] })).toBeNull();
  });

  it.each(["ACCEPTED", "INCONCLUSIVE", "DELIVERED"] as const)("rejects %s as proof of non-delivery", (outcome) => {
    expect(assessDelivery({
      status: "FAILED", deliveryAttempts: [{ ...resolved(), providerEvents: [{ id: "proof", outcome }] }],
    })).toBe("invalid_history");
  });

  it("keeps confirmation as a duplicate barrier after reviewing the unknown attempt", () => {
    const delivered: Attempt = {
      ...resolved(),
      providerEvents: [{ id: "proof", outcome: "DELIVERED" }],
      resolutions: [{ ...first, decision: "CONFIRMED_DELIVERED" }],
    };
    expect(assessDelivery({ status: "UNCERTAIN", deliveryAttempts: [delivered] })).toBe("sent");
    expect(blocksInvoice("sent")).toBe(false);
    expect(blocksInvoice(assessDelivery({ status: "UNCERTAIN", deliveryAttempts: [delivered, unknown()] }))).toBe(true);
  });

  it("treats SUCCESS as a barrier without upgrading acceptance to recipient delivery", () => {
    expect(assessDelivery({ status: "FAILED", deliveryAttempts: [{ ...failed, status: "SUCCESS" }] })).toBe("sent");
    expect(assessDelivery({ status: "FAILED", deliveryAttempts: [{ ...unknown(), providerEvents: [{ id: "a", outcome: "ACCEPTED" }] }] })).toBe("unknown");
  });

  it("keeps freeze even if the history has a resolution", () => {
    expect(assessDelivery({ status: "FAILED", deliveryAttempts: [{ ...resolved(), incidents: [{ id: "open" }] }] })).toBe("frozen");
  });

  it("keeps a previously resolved attempt blocked when verified event identity is reused with different contents", () => {
    const attempt = resolved();
    attempt.providerEvents.push({ id: "conflict", outcome: "INCONCLUSIVE", evidenceMetadata: { idempotencyConflict: true } });
    expect(assessDelivery({ status: "FAILED", deliveryAttempts: [attempt] })).toBe("invalid_history");
  });

  it("fails closed when UNCERTAIN has no corresponding attempt", () => {
    expect(assessDelivery({ status: "UNCERTAIN", deliveryAttempts: [failed] })).toBe("unknown");
  });

  it("blocks a stale PENDING attempt even when its communication says FAILED", () => {
    expect(assessDelivery({ status: "FAILED", deliveryAttempts: [{ ...unknown(), status: "PENDING" }] })).toBe("in_progress");
  });

  it("validates revisions without mutating history, and allows a correction to restore the barrier", () => {
    const correction = { ...first, id: "r2", revision: 2, supersedesId: first.id, decision: "UNRESOLVED", evidenceEventId: null } as const;
    const attempt = { ...resolved(), resolutions: [correction, first] };
    expect(resolutionChain(attempt).head).toEqual(correction);
    expect(attempt.resolutions).toEqual([correction, first]);
    expect(assessDelivery({ status: "FAILED", deliveryAttempts: [attempt] })).toBe("unknown");
  });

  it.each([
    [{ ...first, supersedesId: first.id }],
    [{ ...first, supersedesId: "r2" }, { ...first, id: "r2", revision: 2, supersedesId: first.id }],
    [first, { ...first, id: "r2", revision: 3, supersedesId: first.id }],
    [first, { ...first, id: "r2", revision: 2, supersedesId: "different-attempt" }],
    [first, { ...first, id: "r2", revision: 1 }],
    [first, { ...first, id: first.id, revision: 2, supersedesId: first.id }],
  ])("rejects cyclic, branching, or malformed revision chains", (...resolutions) => {
    expect(resolutionChain({ ...resolved(), resolutions }).valid).toBe(false);
  });

  it("rejects a decision when evidence is absent from its attempt", () => {
    expect(assessDelivery({
      status: "FAILED", deliveryAttempts: [{ ...resolved(), providerEvents: [] }, resolved()],
    })).toBe("invalid_history");
  });
});
