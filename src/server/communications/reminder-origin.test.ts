import { beforeEach, describe, expect, it, vi } from "vitest";

import { prepareReminderCommunication } from "./draft";
import { sendCommunication } from "./send";

const db = vi.hoisted(() => ({
  actionProposal: { findFirst: vi.fn() },
  communication: { findFirst: vi.fn(), findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/server/db/client", () => ({ prisma: db }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/server/rate-limit/service", () => ({ checkRateLimit: vi.fn() }));

function proposal(status: string, stepAction: unknown = "NOTIFY_OWNER") {
  return {
    id: "proposal",
    status,
    type: "SEND_PAYMENT_REMINDER",
    organizationId: "org",
    collectionStepExecution: null,
    insight: { businessEvent: { organizationId: "org", type: "COLLECTION_STEP_DUE", data: { stepAction } } },
  };
}

describe("collection reminder origin", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(["PENDING", "APPROVED"])("blocks legacy %s proposal before reuse or draft creation", async (status) => {
    db.actionProposal.findFirst.mockResolvedValue(proposal(status));
    await expect(prepareReminderCommunication("org", "proposal")).rejects.toThrow("Proposal origin");
    expect(db.communication.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(["DRAFT", "FAILED", "UNCERTAIN", "SENDING"])("blocks legacy %s before dispatch claim", async (status) => {
    db.communication.findFirst.mockResolvedValue({
      status,
      channel: "EMAIL",
      recipient: "customer@example.test",
      actionProposal: proposal("APPROVED"),
    });
    await expect(sendCommunication("org", "communication", "actor", {}))
      .rejects.toThrow("Proposal origin");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([null, "UNKNOWN"])("blocks an ambiguous collection origin (%s)", async (action) => {
    db.actionProposal.findFirst.mockResolvedValue(proposal("APPROVED", action));
    await expect(prepareReminderCommunication("org", "proposal")).rejects.toThrow("Proposal origin");
  });

  it("reuses the existing draft for an ordinary collection reminder", async () => {
    const draft = { id: "draft" };
    db.actionProposal.findFirst.mockResolvedValue(proposal("APPROVED", "SEND_PAYMENT_REMINDER"));
    db.communication.findUnique.mockResolvedValue(draft);
    await expect(prepareReminderCommunication("org", "proposal")).resolves.toEqual({
      communication: draft,
      created: false,
    });
  });

  it("blocks a missing recipient before claiming an ordinary reminder", async () => {
    db.communication.findFirst.mockResolvedValue({
      channel: "EMAIL",
      recipient: " ",
      actionProposal: proposal("APPROVED", "SEND_PAYMENT_REMINDER"),
    });
    await expect(sendCommunication("org", "communication", "actor")).rejects.toThrow("supported recipient");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
