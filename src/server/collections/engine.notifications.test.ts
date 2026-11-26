import { Prisma, type CollectionStepExecution } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAutomationTick } from "./engine";

const { db, draft, send, writeActivity } = vi.hoisted(() => ({
  db: {
    organization: { findUnique: vi.fn(), update: vi.fn() },
    automationTickRun: { create: vi.fn() },
    collectionPolicy: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    collectionSequence: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    collectionPolicyStep: { findMany: vi.fn() },
    collectionStepExecution: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    activityEvent: { create: vi.fn() },
    $transaction: vi.fn(),
    communication: { findMany: vi.fn() },
    businessEvent: { create: vi.fn(), findUnique: vi.fn() },
  },
  draft: vi.fn(),
  send: vi.fn(),
  writeActivity: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ prisma: db }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/server/communications/draft", () => ({ prepareReminderCommunication: draft }));
vi.mock("@/server/communications/send", () => ({ sendCommunication: send }));
vi.mock("./enrollment", () => ({ enrollEligibleInvoices: vi.fn() }));
vi.mock("@/server/billing/entitlements", () => ({ isCollectionsAutomationEntitled: () => true }));
vi.mock("@/server/ar/reminder-context", () => ({ buildDeterministicInvoiceContext: () => ({}) }));
vi.mock("@/server/ar/invoices", () => {
  const entry = {
    invoice: { id: "invoice", dueDate: new Date("2026-01-01"), customer: {} },
    financials: { isPaid: false },
  };
  return { listInvoicesWithFinancials: () => [entry], getInvoiceWithFinancials: () => entry };
});
vi.mock("@/server/operator/approval", () => ({ approveActionProposal: vi.fn() }));
vi.mock("@/server/operator/insights", () => ({
  ensureInsightForInvoiceOverdueEvent: () => ({ insight: { invoiceId: "invoice", customerId: "customer" } }),
}));
vi.mock("@/server/operator/proposals", () => ({
  ensureReminderProposalForInsight: () => ({ proposal: { id: "proposal", invoiceId: "invoice", customerId: "customer" } }),
}));

const sequence = {
  id: "sequence", invoiceId: "invoice", customerId: "customer",
  policyId: "policy", policyVersion: 1, organizationId: "org", status: "ACTIVE",
};
const tick = (day: number) => runAutomationTick(new Date(Date.UTC(2026, 0, day)), {
  organizationId: "org", globalEnabled: true,
});
const step = (action: string, daysAfterDue = 1) => ({
  id: action, policyId: "policy", version: 1, daysAfterDue, action, tone: "STANDARD",
});

type Execution = Pick<CollectionStepExecution, "id" | "sequenceId" | "stepId" | "status">;
type Activity = Prisma.ActivityEventUncheckedCreateInput;

function insertExecution(
  executions: Map<string, Execution>,
  data: Omit<Execution, "id">,
): Execution {
  if (executions.has(data.stepId)) {
    throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
  }
  const execution = { ...data, id: data.stepId };
  executions.set(data.stepId, execution);
  return execution;
}

async function insertActivity(events: Activity[], data: Activity) {
  await writeActivity(data);
  events.push(data);
}

function transactionClient(executions: Map<string, Execution>, events: Activity[]) {
  return {
    $queryRaw: async () => [{ id: "current-claim" }],
    businessEvent: db.businessEvent,
    collectionStepExecution: {
      create: async ({ data }: { data: Omit<Execution, "id"> }) => insertExecution(executions, data),
      updateMany: async ({ where, data }: { where: Pick<Execution, "id" | "status">; data: Pick<Execution, "status"> }) => {
        const execution = executions.get(where.id);
        if (!execution || execution.status !== where.status) return { count: 0 };
        executions.set(execution.stepId, { ...execution, ...data });
        return { count: 1 };
      },
    },
    activityEvent: { create: async ({ data }: { data: Activity }) => insertActivity(events, data) },
  };
}

describe("collection notification action handling", () => {
  let executions: Map<string, Execution>;
  let events: Activity[];

  beforeEach(() => {
    vi.resetAllMocks();
    executions = new Map();
    events = [];
    db.organization.findUnique.mockResolvedValue({ id: "org", automationEnabled: true });
    db.organization.update.mockResolvedValue({});
    db.automationTickRun.create.mockResolvedValue({});
    const policy = { id: "policy", enabled: true, automationMode: "AUTO_SEND", autoSendEnabledByUserId: "actor" };
    db.collectionPolicy.findMany.mockResolvedValue([policy]);
    db.collectionPolicy.findUnique.mockResolvedValue(policy);
    db.collectionSequence.findMany.mockResolvedValue([sequence]);
    db.collectionSequence.findUnique.mockResolvedValue(sequence);
    db.collectionSequence.findUniqueOrThrow.mockResolvedValue(sequence);
    db.collectionStepExecution.findMany.mockImplementation(async (args) =>
      args.where.status === "CLAIMED" ? [] : [...executions.values()],
    );
    db.collectionStepExecution.create.mockImplementation(async ({ data }) => insertExecution(executions, data));
    db.activityEvent.create.mockImplementation(async ({ data }) => insertActivity(events, data));

    // Stage both writes until the callback succeeds. Serialize callbacks to
    // model competing operations on the same execution key.
    let pendingTransaction: Promise<unknown> = Promise.resolve();
    db.$transaction.mockImplementation((run: (tx: ReturnType<typeof transactionClient>) => Promise<unknown>) => {
      const transaction = pendingTransaction.then(async () => {
        const stagedExecutions = new Map(executions);
        const stagedEvents = [...events];
        const result = await run(transactionClient(stagedExecutions, stagedEvents));
        executions = stagedExecutions;
        events = stagedEvents;
        return result;
      });
      pendingTransaction = transaction.catch(() => undefined);
      return transaction;
    });
    db.communication.findMany.mockResolvedValue([]);
    db.businessEvent.findUnique.mockResolvedValue(null);
    db.businessEvent.create.mockImplementation(async ({ data }) => ({ id: "event", ...data }));
    send.mockResolvedValue({ communication: { status: "SENT" } });
    draft.mockResolvedValue({ communication: { id: "draft" } });
  });

  it.each(["NOTIFY_OWNER", "UNKNOWN"])("skips %s once under racing and repeated ticks", async (action) => {
    db.collectionPolicyStep.findMany.mockResolvedValue([step(action)]);
    const results = await Promise.all([tick(2), tick(2), tick(2)]);
    expect(results.reduce((count, result) => count + result.skipped, 0)).toBe(1);
    expect(results.every((result) => result.failed === 0)).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect((await tick(2)).skipped).toBe(0);
    expect([...executions.values()]).toEqual([expect.objectContaining({ status: "SKIPPED" })]);
    expect(events).toEqual([expect.objectContaining({ type: "COLLECTION_STEP_SKIPPED" })]);
    expect(db.activityEvent.create).not.toHaveBeenCalled();
    expect(db.businessEvent.create).not.toHaveBeenCalled();
    expect(draft).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("commits the new skip and its audit event together", async () => {
    db.collectionPolicyStep.findMany.mockResolvedValue([step("NOTIFY_OWNER")]);

    expect((await tick(2)).skipped).toBe(1);
    expect(executions.get("NOTIFY_OWNER")).toMatchObject({
      status: "SKIPPED",
      note: "Owner notification requires internal delivery",
      completedAt: expect.any(Date),
    });
    expect(events).toEqual([expect.objectContaining({
      type: "COLLECTION_STEP_SKIPPED",
      organizationId: "org",
      invoiceId: "invoice",
    })]);
    expect(db.collectionStepExecution.create).not.toHaveBeenCalled();
    expect(db.activityEvent.create).not.toHaveBeenCalled();
  });

  it("rolls back both writes when auditing a new skip fails, then allows a retry", async () => {
    db.collectionPolicyStep.findMany.mockResolvedValue([step("NOTIFY_OWNER")]);
    writeActivity.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("audit insert failed", { code: "P2002", clientVersion: "test" }),
    );

    expect((await tick(2)).failed).toBe(1);
    expect(executions.size).toBe(0);
    expect(events).toEqual([]);

    expect((await tick(2)).skipped).toBe(1);
    expect(executions.get("NOTIFY_OWNER")?.status).toBe("SKIPPED");
    expect(events).toHaveLength(1);
  });

  it("rolls back an unaudited skip transition to CLAIMED", async () => {
    db.collectionPolicyStep.findMany.mockResolvedValue([step("SEND_PAYMENT_REMINDER")]);
    db.collectionSequence.findUniqueOrThrow.mockResolvedValue({ ...sequence, status: "PAUSED" });
    writeActivity.mockRejectedValueOnce(new Error("activity insert failed"));

    expect((await tick(2)).failed).toBe(1);
    expect(executions.get("SEND_PAYMENT_REMINDER")?.status).toBe("CLAIMED");
    expect(events).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("audits a successful transition from CLAIMED only once across ticks", async () => {
    db.collectionPolicyStep.findMany.mockResolvedValue([step("SEND_PAYMENT_REMINDER")]);
    db.collectionSequence.findUniqueOrThrow.mockResolvedValue({ ...sequence, status: "PAUSED" });

    const results = await Promise.all([tick(2), tick(2)]);
    expect(results.map((result) => result.failed)).toEqual([0, 0]);
    expect((await tick(2)).failed).toBe(0);
    expect(executions.get("SEND_PAYMENT_REMINDER")?.status).toBe("SKIPPED");
    expect(events).toEqual([expect.objectContaining({ type: "COLLECTION_STEP_SKIPPED" })]);
    expect(send).not.toHaveBeenCalled();
  });

  it("writes no event if the execution is no longer CLAIMED", async () => {
    db.collectionPolicyStep.findMany.mockResolvedValue([step("SEND_PAYMENT_REMINDER")]);
    db.collectionSequence.findUniqueOrThrow.mockImplementation(async () => {
      const execution = executions.get("SEND_PAYMENT_REMINDER");
      if (!execution) throw new Error("expected a claimed execution");
      executions.set(execution.stepId, { ...execution, status: "SKIPPED" });
      return { ...sequence, status: "PAUSED" };
    });

    expect((await tick(2)).failed).toBe(0);
    expect(executions.get("SEND_PAYMENT_REMINDER")?.status).toBe("SKIPPED");
    expect(writeActivity).not.toHaveBeenCalled();
  });

  it.each(["FAILED", "UNCERTAIN", "SENDING", "exception"] as const)(
    "reports %s from AUTO_SEND without changing the committed execution",
    async (failure) => {
      db.collectionPolicyStep.findMany.mockResolvedValue([step("SEND_PAYMENT_REMINDER")]);
      if (failure === "exception") {
        send.mockRejectedValueOnce(new Error("fixture send error"));
      } else {
        send.mockResolvedValueOnce({ communication: { status: failure } });
      }

      expect(await tick(2)).toMatchObject({ executed: 1, failed: 1 });
      expect(executions.get("SEND_PAYMENT_REMINDER")?.status).toBe("EXECUTED");
      expect(events).toEqual([expect.objectContaining({ type: "COLLECTION_STEP_EXECUTED" })]);
      expect(db.automationTickRun.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ executed: 1, failed: 1, crashed: false }),
      }));

      expect(await tick(2)).toMatchObject({ executed: 0, failed: 0 });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("does not report an intentional pause before dispatch as an AUTO_SEND failure", async () => {
    db.collectionPolicyStep.findMany.mockResolvedValue([step("SEND_PAYMENT_REMINDER")]);
    draft.mockImplementationOnce(async () => {
      db.collectionSequence.findUnique.mockResolvedValue({ ...sequence, status: "PAUSED" });
      return { communication: { id: "draft" } };
    });

    expect(await tick(2)).toMatchObject({ executed: 1, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks a new Collections step for historical UNKNOWN followed by failures", async () => {
    db.collectionPolicyStep.findMany.mockResolvedValue([step("SEND_PAYMENT_REMINDER")]);
    db.communication.findMany.mockResolvedValue([{
      invoiceId: "invoice", status: "FAILED",
      deliveryAttempts: ["UNKNOWN", "FAILED", "FAILED"].map((status) => ({
        status, providerEvents: [], resolutions: [], incidents: [],
      })),
    }]);
    expect(await tick(2)).toMatchObject({ blocked: 1, executed: 0, failed: 0 });
    expect(draft).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("processes a later customer reminder in a mixed policy", async () => {
    db.collectionPolicyStep.findMany.mockResolvedValue([step("NOTIFY_OWNER"), step("SEND_PAYMENT_REMINDER", 2)]);
    expect((await tick(2)).skipped).toBe(1);
    expect((await tick(3)).executed).toBe(1);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledExactlyOnceWith("org", "draft", "actor", expect.objectContaining({
      actorSource: "AUTOMATION",
    }));
  });
});
