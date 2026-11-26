import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDelivery } from "./delivery-resolutions";

const { tx, transact, lock } = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn(),
    communication: { findFirstOrThrow: vi.fn() },
    deliveryResolution: { create: vi.fn() },
    activityEvent: { create: vi.fn() },
  },
  transact: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/server/db/client", () => ({ prisma: { $transaction: transact } }));
vi.mock("./delivery-guard", async (original) => ({
  ...await original<typeof import("./delivery-guard")>(), lockDeliveryCommunication: lock,
}));

const actor = { organizationId: "org", userId: "owner" };
const target = { communicationId: "comm", proposalId: "proposal" };
const decision = { attemptId: "attempt", previousId: null, decision: "UNRESOLVED", reason: "Still unknown" } as const;

describe("resolveDelivery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transact.mockImplementation((run) => run(tx));
    tx.$queryRaw.mockResolvedValue([{ id: "membership" }]);
    lock.mockResolvedValue({ id: "comm", actionProposalId: "proposal", invoiceId: "invoice", customerId: "customer" });
    tx.communication.findFirstOrThrow.mockResolvedValue({
      deliveryAttempts: [{ id: "attempt", status: "UNKNOWN", providerEvents: [], resolutions: [], incidents: [] }],
    });
  });

  it("rejects a caller without an OWNER membership before loading the communication", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await expect(resolveDelivery(actor, target, decision)).rejects.toThrow();
    expect(tx.$queryRaw.mock.calls[0][0].join("")).toContain("role = 'OWNER'");
    expect(lock).not.toHaveBeenCalled();
    expect(tx.deliveryResolution.create).not.toHaveBeenCalled();
  });

  it("rejects a mismatched proposal within the organization", async () => {
    await expect(resolveDelivery(actor, { ...target, proposalId: "unrelated" }, decision)).rejects.toThrow();
    expect(tx.deliveryResolution.create).not.toHaveBeenCalled();
  });

  it("rejects a non-delivery decision without an authoritative event for the attempt", async () => {
    await expect(resolveDelivery(actor, target, {
      ...decision, decision: "CONFIRMED_NOT_DELIVERED", evidenceEventId: "elsewhere",
    })).rejects.toThrow("Verified evidence");
    expect(tx.deliveryResolution.create).not.toHaveBeenCalled();
  });

  it("adds a correction with the authenticated operator and leaves the prior record alone", async () => {
    const before = { id: "r1", revision: 1, supersedesId: null, decision: "UNRESOLVED", evidenceEventId: null };
    tx.communication.findFirstOrThrow.mockResolvedValue({
      deliveryAttempts: [{ id: "attempt", status: "UNKNOWN", providerEvents: [], resolutions: [before], incidents: [] }],
    });
    tx.deliveryResolution.create.mockImplementation(({ data }) => Promise.resolve({ ...data, id: "r2" }));
    await expect(resolveDelivery(actor, target, { ...decision, previousId: "r1" })).resolves.toMatchObject({
      id: "r2", revision: 2, supersedesId: "r1", operatorId: actor.userId,
    });
    expect(tx.activityEvent.create).toHaveBeenCalledTimes(1);
    expect(before).toEqual({ id: "r1", revision: 1, supersedesId: null, decision: "UNRESOLVED", evidenceEventId: null });
  });
});
