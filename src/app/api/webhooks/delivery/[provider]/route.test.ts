import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeliveryEventConflictError, DeliveryEvidenceUncorrelatedError } from "@/server/communications/delivery-evidence";

import { POST } from "./route";

const { verify, record } = vi.hoisted(() => ({ verify: vi.fn(), record: vi.fn() }));
vi.mock("@/server/communications/delivery-evidence", async (original) => ({
  ...await original<typeof import("@/server/communications/delivery-evidence")>(),
  deliveryWebhookAdapters: new Map([["fixture", { verify }]]),
}));
vi.mock("@/server/communications/delivery-provider-events", () => ({ recordVerifiedDeliveryWebhook: record }));

function post(provider = "fixture") {
  return POST(new Request("https://paynora.test/api/webhooks/delivery/fixture", { method: "POST" }), {
    params: Promise.resolve({ provider }),
  });
}

describe("delivery webhook", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps unconfigured providers disabled", async () => {
    expect((await post("smtp")).status).toBe(404);
    expect(verify).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("does not persist an unauthenticated request", async () => {
    verify.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("returns success after the verified event is committed", async () => {
    const evidence = { attemptKey: "a", externalEventId: "event", providerAccountRef: "fixture", outcome: "DELIVERED" };
    verify.mockResolvedValue(evidence);
    record.mockResolvedValue({ duplicate: false, incidentCreated: true });
    expect((await post()).status).toBe(204);
    expect(record).toHaveBeenCalledExactlyOnceWith("fixture", evidence);
  });

  it.each([
    [new DeliveryEventConflictError(), 409],
    [new DeliveryEvidenceUncorrelatedError(), 422],
  ])("reports an invalid correlation safely with status %i", async (error, status) => {
    verify.mockResolvedValue({});
    record.mockRejectedValue(error);
    expect((await post()).status).toBe(status);
  });
});
