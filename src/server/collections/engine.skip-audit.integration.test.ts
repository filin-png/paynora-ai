import { Prisma, type ActivityEventType, type CollectionStepAction, type CommunicationStatus, type DeliveryAttemptStatus } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { tryGenerateStructured } from "@/server/ai/service";
import { cancelInvoice } from "@/server/ar/invoices";
import { prepareReminderCommunication } from "@/server/communications/draft";
import { sendCommunication } from "@/server/communications/send";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";

import { runAutomationTick } from "./engine";
import { enrollInvoice } from "./enrollment";
import { updateCollectionPolicySteps } from "./policy";
import { pauseCollectionSequence, resumeCollectionSequence, stopCollectionSequenceManually } from "./sequences";
import { createAutomationReadyOrg, createTestInvoice } from "./test-fixtures";

const scenario = vi.hoisted(() => ({
  rejectActivity: null as ActivityEventType | null,
  afterClaim: null as (() => Promise<void>) | null,
  failProposal: false,
  auditErrorCode: undefined as string | undefined,
  cancelAfterClaim: null as string | null,
  stateBeforeCancellation: undefined as string | undefined,
}));

vi.mock("@/server/ar/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ar/activity")>();
  return {
    ...actual,
    recordActivityEvent: async (...args: Parameters<typeof actual.recordActivityEvent>) => {
      const [client, input] = args;
      if (scenario.rejectActivity !== input.type) {
        return actual.recordActivityEvent(client, input);
      }
      // Use the real insert and let PostgreSQL reject the missing customer FK.
      try {
        await actual.recordActivityEvent(client, { ...input, customerId: "d05a-nonexistent-customer" });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) scenario.auditErrorCode = error.code;
        throw error;
      }
    },
  };
});

vi.mock("@/server/ar/invoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ar/invoices")>();
  return {
    ...actual,
    getInvoiceWithFinancials: async (...args: Parameters<typeof actual.getInvoiceWithFinancials>) => {
      const [organizationId, invoiceId] = args;
      if (scenario.cancelAfterClaim === invoiceId) {
        scenario.cancelAfterClaim = null;
        const execution = await prisma.collectionStepExecution.findFirstOrThrow({ where: { organizationId } });
        scenario.stateBeforeCancellation = execution.status;
        await actual.cancelInvoice(organizationId, invoiceId);
      }
      const afterClaim = scenario.afterClaim;
      scenario.afterClaim = null;
      await afterClaim?.();
      return actual.getInvoiceWithFinancials(...args);
    },
  };
});

vi.mock("@/server/ai/service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/ai/service")>(),
  tryGenerateStructured: vi.fn(async () => null),
}));

vi.mock("@/server/communications/draft", () => ({
  prepareReminderCommunication: vi.fn(async () => { throw new Error("Recovery must never prepare a communication"); }),
}));
vi.mock("@/server/communications/send", () => ({
  sendCommunication: vi.fn(async () => { throw new Error("Recovery must never send a communication"); }),
}));

vi.mock("@/server/operator/proposals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/operator/proposals")>();
  return {
    ...actual,
    ensureReminderProposalForInsight: async (...args: Parameters<typeof actual.ensureReminderProposalForInsight>) => {
      if (scenario.failProposal) throw new Error("Injected failure before proposal creation");
      return actual.ensureReminderProposalForInsight(...args);
    },
  };
});

beforeAll(async () => {
  const [target] = await prisma.$queryRaw<{ ok: boolean | null }[]>`
    SELECT current_database() = 'paynora_test'
       AND session_user = 'paynora_test_runner'
       AND current_user = 'paynora_test_runner'
       AND inet_server_addr() = '127.0.0.1'::inet
       AND inet_server_port() = 55432
       AND current_schema() = 'public'
       AND current_setting('cluster_name', true) = 'paynora_test_isolated'
       AND current_setting('server_version_num')::int / 10000 = 17
       AND current_setting('transaction_read_only') = 'off'
       AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'paynora')
       AS ok
  `;
  expect(target?.ok, "Collections integration requires the writable isolated PostgreSQL 17 runner connection").toBe(true);
});

beforeEach(async () => {
  scenario.rejectActivity = null;
  scenario.auditErrorCode = undefined;
  scenario.afterClaim = null;
  scenario.failProposal = false;
  vi.mocked(tryGenerateStructured).mockClear();
  vi.mocked(prepareReminderCommunication).mockClear();
  vi.mocked(sendCommunication).mockClear();
  scenario.cancelAfterClaim = null;
  scenario.stateBeforeCancellation = undefined;
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createDueStep(action: CollectionStepAction) {
  const { organization, customer, policy } = await createAutomationReadyOrg("D05a");
  const updated = await updateCollectionPolicySteps(organization.id, policy.id, [
    { daysAfterDue: 1, action, tone: "STANDARD" },
  ]);
  const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
  const { sequence } = await enrollInvoice(
    organization.id, invoice.id, customer.id, policy.id, updated.currentVersion,
  );
  const scope = { organizationId: organization.id, customerId: customer.id, invoiceId: invoice.id };
  return {
    scope,
    invoiceId: invoice.id,
    sequenceId: sequence.id,
    sequenceState: () => prisma.collectionSequence.findUniqueOrThrow({ where: { id: sequence.id } }),
    auditEvents: (type: ActivityEventType) => prisma.activityEvent.findMany({ where: { ...scope, type } }),
    stepEvents: () => prisma.businessEvent.findMany({
      where: { ...scope, type: "COLLECTION_STEP_DUE" },
      include: { insights: { include: { proposals: true } } },
    }),
    tick: (now = new Date("2026-01-02T00:00:00Z")) => runAutomationTick(now, {
      organizationId: organization.id, globalEnabled: true, aiOverride: { enabled: false },
    }),
    executions: () => prisma.collectionStepExecution.findMany({ where: { sequenceId: sequence.id } }),
    skipEvents: () => prisma.activityEvent.findMany({
      where: { organizationId: organization.id, invoiceId: invoice.id, type: "COLLECTION_STEP_SKIPPED" },
    }),
    proposals: () => prisma.actionProposal.count({ where: { organizationId: organization.id, invoiceId: invoice.id } }),
    communications: () => prisma.communication.count({ where: { organizationId: organization.id, invoiceId: invoice.id } }),
  };
}

describe("D05.a skip audit on PostgreSQL", () => {
  it("commits a new SKIPPED execution and exactly one audit event", async () => {
    const fixture = await createDueStep("NOTIFY_OWNER");

    expect(await fixture.tick()).toMatchObject({ skipped: 1, executed: 0, failed: 0 });
    expect(await fixture.executions()).toEqual([expect.objectContaining({
      status: "SKIPPED", note: "Owner notification requires internal delivery", completedAt: expect.any(Date),
    })]);
    expect(await fixture.skipEvents()).toHaveLength(1);
    expect(await fixture.proposals()).toBe(0);
    expect(await fixture.communications()).toBe(0);
  });

  it("rolls back a new SKIPPED execution when PostgreSQL rejects the audit insert", async () => {
    const fixture = await createDueStep("NOTIFY_OWNER");
    scenario.rejectActivity = "COLLECTION_STEP_SKIPPED";

    expect(await fixture.tick()).toMatchObject({ failed: 1, skipped: 0, executed: 0 });
    expect(scenario.auditErrorCode).toBe("P2003");
    expect(await fixture.executions()).toEqual([]);
    expect(await fixture.skipEvents()).toEqual([]);

    scenario.rejectActivity = null;
    expect(await fixture.tick()).toMatchObject({ failed: 0, skipped: 1 });
    expect(await fixture.skipEvents()).toHaveLength(1);
  });

  it("transitions a claimed step to SKIPPED and audits it after invoice cancellation", async () => {
    const fixture = await createDueStep("SEND_PAYMENT_REMINDER");
    scenario.cancelAfterClaim = fixture.invoiceId;

    expect(await fixture.tick()).toMatchObject({ claimed: 1, stopped: 1, executed: 0, failed: 0 });
    expect(scenario.stateBeforeCancellation).toBe("CLAIMED");
    expect(await fixture.executions()).toEqual([expect.objectContaining({
      status: "SKIPPED", note: "Invoice cancelled between claim and execution", completedAt: expect.any(Date),
    })]);
    expect(await fixture.skipEvents()).toHaveLength(1);
    expect(await fixture.proposals()).toBe(0);
    expect(await fixture.communications()).toBe(0);
  });

  it("keeps the original CLAIMED state when audit insertion fails during the transition", async () => {
    const fixture = await createDueStep("SEND_PAYMENT_REMINDER");
    scenario.cancelAfterClaim = fixture.invoiceId;
    scenario.rejectActivity = "COLLECTION_STEP_SKIPPED";

    expect(await fixture.tick()).toMatchObject({ failed: 1, executed: 0 });
    expect(scenario.stateBeforeCancellation).toBe("CLAIMED");
    expect(scenario.auditErrorCode).toBe("P2003");
    expect(await fixture.executions()).toEqual([expect.objectContaining({
      status: "CLAIMED", note: null, completedAt: null,
    })]);
    expect(await fixture.skipEvents()).toEqual([]);
    expect(await fixture.communications()).toBe(0);
  });

  it("deduplicates SKIPPED and its audit across two racing transactions and a repeat tick", async () => {
    const fixture = await createDueStep("NOTIFY_OWNER");
    const original = prisma.$transaction;
    const transact = original.bind(prisma);
    const backendIds = new Set<number>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const timer = setTimeout(release, 3000);
    // Hold both actual transactions after the tick's initial read. Each
    // worker then attempts the same insert on a distinct PostgreSQL backend.
    prisma.$transaction = ((run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      transact(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        backendIds.add(pid);
        if (backendIds.size === 2) release();
        await gate;
        return run(tx);
      })) as typeof prisma.$transaction;

    try {
      const [first, second] = await Promise.all([fixture.tick(), fixture.tick()]);
      expect(backendIds.size).toBe(2);
      expect(first.failed + second.failed).toBe(0);
      expect(first.skipped + second.skipped).toBe(1);
      expect(first.executed + second.executed).toBe(0);
    } finally {
      clearTimeout(timer);
      prisma.$transaction = original;
    }

    expect(await fixture.tick()).toMatchObject({ skipped: 0, executed: 0, failed: 0 });
    expect(await fixture.executions()).toEqual([expect.objectContaining({ status: "SKIPPED" })]);
    expect(await fixture.skipEvents()).toHaveLength(1);
    expect(await fixture.proposals()).toBe(0);
    expect(await fixture.communications()).toBe(0);
  });
});

describe("Collections execution recovery on PostgreSQL", () => {
  it("rolls back EXECUTED and its links when PostgreSQL rejects the audit", async () => {
    const fixture = await createDueStep("SEND_PAYMENT_REMINDER");
    scenario.rejectActivity = "COLLECTION_STEP_EXECUTED";

    expect(await fixture.tick()).toMatchObject({ failed: 1, executed: 0 });
    expect(scenario.auditErrorCode).toBe("P2003");
    const executions = await fixture.executions();
    expect(executions).toEqual([expect.objectContaining({
      status: "CLAIMED", businessEventId: null, actionProposalId: null, completedAt: null,
    })]);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toEqual([]);
    expect(await fixture.stepEvents()).toEqual([expect.objectContaining({
      dedupeKey: executions[0]?.id,
      insights: [expect.objectContaining({ proposals: [expect.objectContaining({ status: "PENDING" })] })],
    })]);

    scenario.rejectActivity = null;
    expect(await fixture.tick()).toMatchObject({ failed: 0, claimed: 0, executed: 0 });
    expect(await fixture.executions()).toEqual(executions);
    expect(await fixture.proposals()).toBe(1);
    expect(await fixture.communications()).toBe(0);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toEqual([]);
  });

  it("leaves an unfinalized claim after an interruption between insight and proposal", async () => {
    const fixture = await createDueStep("SEND_PAYMENT_REMINDER");
    scenario.failProposal = true;

    expect(await fixture.tick()).toMatchObject({ failed: 1, executed: 0 });
    const executions = await fixture.executions();
    expect(executions).toEqual([expect.objectContaining({ status: "CLAIMED" })]);
    expect(await fixture.stepEvents()).toEqual([expect.objectContaining({
      insights: [expect.objectContaining({ proposals: [] })],
    })]);

    scenario.failProposal = false;
    expect(await fixture.tick()).toMatchObject({ failed: 0, claimed: 0, executed: 0 });
    expect(await fixture.executions()).toEqual(executions);
    expect(await fixture.proposals()).toBe(0);
    expect(await fixture.communications()).toBe(0);
  });

  it.each(["event", "insight", "proposal"] as const)("continues the owned claim using an existing %s", async (phase) => {
    const fixture = await createDueStep("SEND_PAYMENT_REMINDER");
    const seeded: { eventId?: string; insightId?: string; proposalId?: string } = {};
    scenario.afterClaim = async () => {
      const [execution] = await fixture.executions();
      expect(execution?.status).toBe("CLAIMED");
      const event = await prisma.businessEvent.create({
        data: {
          ...fixture.scope,
          type: "COLLECTION_STEP_DUE",
          dedupeKey: execution.id,
          data: { stepAction: "SEND_PAYMENT_REMINDER" },
        },
      });
      seeded.eventId = event.id;
      if (phase === "event") return;

      const insight = await prisma.operatorInsight.create({
        data: { ...fixture.scope, businessEventId: event.id, priority: "MEDIUM", summary: "Existing insight" },
      });
      seeded.insightId = insight.id;
      if (phase === "insight") return;

      const proposal = await prisma.actionProposal.create({
        data: {
          ...fixture.scope, insightId: insight.id, type: "SEND_PAYMENT_REMINDER",
          status: "DISMISSED", reasoning: insight.summary,
        },
      });
      seeded.proposalId = proposal.id;
    };

    expect(await fixture.tick()).toMatchObject({ failed: 0, executed: 1 });
    const [execution] = await fixture.executions();
    expect(execution).toMatchObject({ status: "EXECUTED", businessEventId: seeded.eventId });
    const events = await fixture.stepEvents();
    expect(events).toHaveLength(1);
    expect(events[0].insights).toHaveLength(1);
    const [insight] = events[0].insights;
    expect(insight.proposals).toHaveLength(1);
    const [proposal] = insight.proposals;
    expect(execution.actionProposalId).toBe(proposal.id);
    if (seeded.insightId) {
      expect(insight.id).toBe(seeded.insightId);
      expect(tryGenerateStructured).not.toHaveBeenCalled();
    }
    if (seeded.proposalId) expect(proposal).toMatchObject({ id: seeded.proposalId, status: "DISMISSED" });

    expect(await fixture.tick()).toMatchObject({ failed: 0, claimed: 0, executed: 0 });
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toHaveLength(1);
    expect(await fixture.proposals()).toBe(1);
    expect(await fixture.communications()).toBe(0);
  });
});

describe("Collections sequence audit on PostgreSQL", () => {
  it("rolls back an automatic stop, then stops and audits exactly once on the next tick", async () => {
    const fixture = await createDueStep("SEND_PAYMENT_REMINDER");
    await cancelInvoice(fixture.scope.organizationId, fixture.invoiceId);
    const before = await fixture.sequenceState();
    scenario.rejectActivity = "COLLECTION_SEQUENCE_STOPPED";

    expect(await fixture.tick()).toMatchObject({ failed: 1, stopped: 0 });
    expect(scenario.auditErrorCode).toBe("P2003");
    expect(await fixture.sequenceState()).toEqual(before);
    expect(await fixture.auditEvents("COLLECTION_SEQUENCE_STOPPED")).toEqual([]);

    scenario.rejectActivity = null;
    expect(await fixture.tick()).toMatchObject({ failed: 0, stopped: 1 });
    expect(await fixture.sequenceState()).toMatchObject({ status: "STOPPED", stopReason: "CANCELLED" });
    expect(await fixture.tick()).toMatchObject({ failed: 0, stopped: 0 });
    expect(await fixture.auditEvents("COLLECTION_SEQUENCE_STOPPED")).toHaveLength(1);
  });

  it.each([
    ["pause", pauseCollectionSequence, "COLLECTION_SEQUENCE_PAUSED", "PAUSED"],
    ["resume", resumeCollectionSequence, "COLLECTION_SEQUENCE_RESUMED", "ACTIVE"],
    ["stop", stopCollectionSequenceManually, "COLLECTION_SEQUENCE_STOPPED", "STOPPED"],
  ] as const)("rolls back manual %s if audit fails and deduplicates concurrent transitions", async (action, transition, auditType, status) => {
    const fixture = await createDueStep("SEND_PAYMENT_REMINDER");
    const { scope: { organizationId }, sequenceId } = fixture;
    if (action === "resume") await pauseCollectionSequence(organizationId, sequenceId);
    const before = await fixture.sequenceState();
    scenario.rejectActivity = auditType;

    await expect(transition(organizationId, sequenceId)).rejects.toMatchObject({ code: "P2003" });
    expect(await fixture.sequenceState()).toEqual(before);
    expect(await fixture.auditEvents(auditType)).toEqual([]);

    scenario.rejectActivity = null;
    const results = await Promise.all([
      transition(organizationId, sequenceId),
      transition(organizationId, sequenceId),
    ]);
    expect(results.map((result) => result.status)).toEqual([status, status]);
    expect(await fixture.auditEvents(auditType)).toHaveLength(1);
  });
});

const recoveryNow = new Date("2026-01-02T12:00:00Z");
const staleClaimTime = new Date("2026-01-02T11:30:00Z");

async function seedRecoveryClaim(phase: "claim" | "event" | "insight" | "proposal", claimedAt = staleClaimTime) {
  const fixture = await createDueStep("SEND_PAYMENT_REMINDER");
  const sequence = await fixture.sequenceState();
  const step = await prisma.collectionPolicyStep.findFirstOrThrow({
    where: { policyId: sequence.policyId, version: sequence.policyVersion },
  });
  const claim = await prisma.collectionStepExecution.create({
    data: { organizationId: fixture.scope.organizationId, sequenceId: sequence.id, stepId: step.id, claimedAt },
  });
  const event = phase === "claim" ? null : await prisma.businessEvent.create({
    data: {
      ...fixture.scope, type: "COLLECTION_STEP_DUE", dedupeKey: claim.id,
      data: { stepAction: "SEND_PAYMENT_REMINDER" },
    },
  });
  const insight = !event || phase === "event" ? null : await prisma.operatorInsight.create({
    data: { ...fixture.scope, businessEventId: event.id, summary: "Existing recovery insight", priority: "LOW" },
  });
  const proposal = !insight || phase === "insight" ? null : await prisma.actionProposal.create({
    data: { ...fixture.scope, insightId: insight.id, type: "SEND_PAYMENT_REMINDER", reasoning: insight.summary },
  });
  return {
    ...fixture,
    claim, event, insight, proposal,
    recover: () => fixture.tick(recoveryNow),
    execution: () => prisma.collectionStepExecution.findUniqueOrThrow({ where: { id: claim.id } }),
  };
}

async function seedDelivery(
  fixture: Awaited<ReturnType<typeof seedRecoveryClaim>>,
  status: CommunicationStatus,
  attemptStatus?: DeliveryAttemptStatus,
) {
  if (!fixture.proposal) throw new Error("Test fixture requires a proposal");
  await prisma.actionProposal.update({
    where: { id: fixture.proposal.id }, data: { status: status === "SENT" ? "EXECUTED" : "APPROVED" },
  });
  const communication = await prisma.communication.create({
    data: {
      ...fixture.scope, actionProposalId: fixture.proposal.id, status, purpose: "PAYMENT_REMINDER",
      recipient: "safe-fixture@example.test", subject: "Recovery fixture", body: "Recovery fixture",
      sentAt: status === "SENT" ? staleClaimTime : null,
    },
  });
  if (attemptStatus) {
    await prisma.deliveryAttempt.create({
      data: {
        organizationId: fixture.scope.organizationId, communicationId: communication.id,
        attemptNumber: 1, provider: "fake", status: attemptStatus, idempotencyKey: communication.id,
        completedAt: attemptStatus === "PENDING" ? null : staleClaimTime,
      },
    });
  }
  return () => prisma.communication.findUniqueOrThrow({
    where: { id: communication.id }, include: { deliveryAttempts: true },
  });
}

describe("Collections stale claim recovery on PostgreSQL", () => {
  afterEach(() => {
    expect(prepareReminderCommunication).not.toHaveBeenCalled();
    expect(sendCommunication).not.toHaveBeenCalled();
    expect(tryGenerateStructured).not.toHaveBeenCalled();
  });

  it.each(["event", "insight", "proposal"] as const)("recovers after the original worker committed %s", async (phase) => {
    const fixture = await seedRecoveryClaim(phase);

    expect(await fixture.recover()).toMatchObject({ recovered: 1, executed: 1, claimed: 0, failed: 0 });
    const [event] = await fixture.stepEvents();
    const [insight] = event.insights;
    const [proposal] = insight.proposals;
    if (fixture.insight) expect(insight.id).toBe(fixture.insight.id);
    if (fixture.proposal) expect(proposal.id).toBe(fixture.proposal.id);
    expect(proposal.status).toBe("PENDING");
    expect(await fixture.execution()).toMatchObject({
      status: "EXECUTED", businessEventId: fixture.event?.id, actionProposalId: proposal.id,
    });
    expect(await fixture.recover()).toMatchObject({ recovered: 0, executed: 0, claimed: 0, recoveryNeedsReview: 0 });
    expect(await fixture.stepEvents()).toEqual([event]);
    expect(await fixture.communications()).toBe(0);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toEqual([expect.objectContaining({
      metadata: {
        executionId: fixture.claim.id, sequenceId: fixture.sequenceId,
        recovery: { outcome: "recovered", delivery: "none", insightCreated: phase === "event", proposalCreated: phase !== "proposal" },
      },
    })]);
  });

  it("does not touch a claim just inside the age limit", async () => {
    const fixture = await seedRecoveryClaim("event", new Date(staleClaimTime.getTime() + 1));
    expect(await fixture.recover()).toMatchObject({ recovered: 0, blocked: 1, recoveryNeedsReview: 0 });
    expect(await fixture.execution()).toEqual(fixture.claim);
    expect(await fixture.proposals()).toBe(0);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toEqual([]);
  });

  it("keeps a claim without a proven BusinessEvent for manual review only once", async () => {
    const fixture = await seedRecoveryClaim("claim");

    expect(await fixture.recover()).toMatchObject({ recoveryNeedsReview: 1, recovered: 0, blocked: 1, failed: 0 });
    expect(await fixture.execution()).toMatchObject({ status: "CLAIMED", note: expect.stringContaining("BUSINESS_EVENT_MISSING") });
    expect(await fixture.recover()).toMatchObject({ recoveryNeedsReview: 0, recovered: 0, blocked: 1 });
    expect(await fixture.stepEvents()).toHaveLength(0);
    expect(await fixture.proposals()).toBe(0);
    expect(await fixture.auditEvents("COLLECTION_STEP_SKIPPED")).toEqual([expect.objectContaining({
      metadata: {
        executionId: fixture.claim.id, sequenceId: fixture.sequenceId,
        recovery: { outcome: "manual_review", reason: "BUSINESS_EVENT_MISSING", status: "CLAIMED" },
      },
    })]);
  });

  it("protects a mismatching BusinessEvent and makes no new proposal", async () => {
    const fixture = await seedRecoveryClaim("event");
    await prisma.businessEvent.update({ where: { id: fixture.event!.id }, data: { data: { stepAction: "NOTIFY_OWNER" } } });

    expect(await fixture.recover()).toMatchObject({ recoveryNeedsReview: 1, recovered: 0, failed: 0 });
    expect(await fixture.execution()).toMatchObject({ status: "CLAIMED", note: expect.stringContaining("BUSINESS_EVENT_MISMATCH") });
    expect(await fixture.stepEvents()).toHaveLength(1);
    expect(await fixture.proposals()).toBe(0);
  });

  it("does not create a proposal after the invoice became cancelled", async () => {
    const fixture = await seedRecoveryClaim("insight");
    await cancelInvoice(fixture.scope.organizationId, fixture.invoiceId);

    expect(await fixture.recover()).toMatchObject({ recoveryNeedsReview: 1, recovered: 0, stopped: 1, failed: 0 });
    expect(await fixture.execution()).toMatchObject({ status: "CLAIMED", note: expect.stringContaining("REMINDER_NO_LONGER_ELIGIBLE") });
    expect(await fixture.proposals()).toBe(0);
  });

  it("never creates a new proposal while another claim in the sequence is unresolved", async () => {
    const fixture = await seedRecoveryClaim("claim");
    const sequence = await fixture.sequenceState();
    // Legacy workers could leave an older claim behind and claim a later step.
    const next = await prisma.collectionPolicyStep.create({
      data: {
        policyId: sequence.policyId, version: sequence.policyVersion, stepOrder: 2,
        daysAfterDue: 2, action: "SEND_PAYMENT_REMINDER",
      },
    });
    const nextClaim = await prisma.collectionStepExecution.create({
      data: {
        organizationId: fixture.scope.organizationId, sequenceId: sequence.id, stepId: next.id,
        claimedAt: new Date("2026-01-03T11:30:00Z"),
      },
    });
    await prisma.businessEvent.create({
      data: {
        ...fixture.scope, type: "COLLECTION_STEP_DUE", dedupeKey: nextClaim.id,
        data: { stepAction: "SEND_PAYMENT_REMINDER" },
      },
    });

    expect(await fixture.tick(new Date("2026-01-03T12:00:00Z"))).toMatchObject({
      recoveryNeedsReview: 2, recovered: 0, blocked: 1, failed: 0,
    });
    expect(await fixture.proposals()).toBe(0);
    expect(await fixture.executions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: nextClaim.id, status: "CLAIMED", note: expect.stringContaining("OTHER_CLAIM_UNRESOLVED") }),
    ]));
  });

  it("finalizes an existing draft with no dispatch attempts without changing it", async () => {
    const fixture = await seedRecoveryClaim("proposal");
    const read = await seedDelivery(fixture, "DRAFT");
    const before = await read();

    expect(await fixture.recover()).toMatchObject({ recovered: 1, executed: 1, failed: 0 });
    expect(await fixture.execution()).toMatchObject({ status: "EXECUTED", actionProposalId: fixture.proposal?.id });
    expect(await read()).toEqual(before);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ recovery: expect.objectContaining({ delivery: "draft" }) }),
    })]);
    expect(await fixture.recover()).toMatchObject({ recovered: 0, executed: 0 });
    expect(await read()).toEqual(before);
  });

  it("links confirmed delivery without scheduling or creating another attempt", async () => {
    const fixture = await seedRecoveryClaim("proposal");
    const read = await seedDelivery(fixture, "SENT", "SUCCESS");
    const before = await read();

    expect(await fixture.recover()).toMatchObject({ recovered: 1, executed: 1, failed: 0 });
    expect(await read()).toEqual(before);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ recovery: expect.objectContaining({ delivery: "sent" }) }),
    })]);
  });

  it.each([
    ["SENDING", "PENDING", "DELIVERY_UNKNOWN"],
    ["UNCERTAIN", "UNKNOWN", "DELIVERY_UNKNOWN"],
    ["DRAFT", "PENDING", "DELIVERY_UNKNOWN"],
    ["SENT", "UNKNOWN", "DELIVERY_UNKNOWN"],
    ["FAILED", "FAILED", "DELIVERY_UNPROVEN"],
  ] as const)("retains %s with %s attempt history for manual review", async (status, attempt, reason) => {
    const fixture = await seedRecoveryClaim("proposal");
    const read = await seedDelivery(fixture, status, attempt);
    const before = await read();

    expect(await fixture.recover()).toMatchObject({ recoveryNeedsReview: 1, recovered: 0, blocked: 1 });
    expect(await fixture.execution()).toMatchObject({ status: "CLAIMED", note: expect.stringContaining(reason) });
    expect(await fixture.recover()).toMatchObject({ recoveryNeedsReview: 0, recovered: 0, blocked: 1 });
    expect(await read()).toEqual(before);
    expect(await fixture.auditEvents("COLLECTION_STEP_SKIPPED")).toHaveLength(1);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toHaveLength(0);
  });

  it("blocks recovery for UNKNOWN older than the two most recent failed attempts", async () => {
    const fixture = await seedRecoveryClaim("proposal");
    const read = await seedDelivery(fixture, "FAILED", "UNKNOWN");
    const communication = await read();
    await prisma.deliveryAttempt.createMany({
      data: [2, 3].map((attemptNumber) => ({
        organizationId: fixture.scope.organizationId, communicationId: communication.id,
        attemptNumber, provider: "fake", status: "FAILED" as const,
        idempotencyKey: `${communication.id}:${attemptNumber}`, completedAt: staleClaimTime,
      })),
    });
    expect(await fixture.recover()).toMatchObject({ recoveryNeedsReview: 1, recovered: 0, blocked: 1 });
    expect(await fixture.execution()).toMatchObject({ status: "CLAIMED", note: expect.stringContaining("DELIVERY_UNKNOWN") });
    expect((await read()).deliveryAttempts).toHaveLength(3);
  });

  it("does not replay a draft when the original worker already committed EXECUTED", async () => {
    const fixture = await seedRecoveryClaim("proposal");
    const read = await seedDelivery(fixture, "DRAFT");
    await prisma.collectionStepExecution.update({
      where: { id: fixture.claim.id },
      data: {
        status: "EXECUTED", businessEventId: fixture.event!.id,
        actionProposalId: fixture.proposal!.id, completedAt: staleClaimTime,
      },
    });
    const before = await read();

    expect(await fixture.recover()).toMatchObject({ recovered: 0, executed: 0, recoveryNeedsReview: 0 });
    expect(await read()).toEqual(before);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toHaveLength(0);
  });

  it("rolls back the recovered insight, proposal and finalization when audit fails", async () => {
    const fixture = await seedRecoveryClaim("event");
    scenario.rejectActivity = "COLLECTION_STEP_EXECUTED";

    expect(await fixture.recover()).toMatchObject({ failed: 1, recovered: 0, executed: 0 });
    expect(scenario.auditErrorCode).toBe("P2003");
    expect(await fixture.execution()).toEqual(fixture.claim);
    expect(await fixture.stepEvents()).toEqual([expect.objectContaining({ insights: [] })]);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toHaveLength(0);

    scenario.rejectActivity = null;
    expect(await fixture.recover()).toMatchObject({ failed: 0, recovered: 1, executed: 1 });
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toHaveLength(1);
  });

  it("rolls back the manual review marker when audit fails", async () => {
    const fixture = await seedRecoveryClaim("claim");
    scenario.rejectActivity = "COLLECTION_STEP_SKIPPED";

    expect(await fixture.recover()).toMatchObject({ failed: 1, recoveryNeedsReview: 0, blocked: 1 });
    expect(scenario.auditErrorCode).toBe("P2003");
    expect(await fixture.execution()).toEqual(fixture.claim);
    expect(await fixture.auditEvents("COLLECTION_STEP_SKIPPED")).toHaveLength(0);

    scenario.rejectActivity = null;
    expect(await fixture.recover()).toMatchObject({ failed: 0, recoveryNeedsReview: 1 });
    expect(await fixture.auditEvents("COLLECTION_STEP_SKIPPED")).toHaveLength(1);
  });

  it("recovers only once when two PostgreSQL backends race for the claim", async () => {
    const fixture = await seedRecoveryClaim("event");
    const original = prisma.$transaction;
    const transact = original.bind(prisma);
    const backendIds = new Set<number>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const timer = setTimeout(release, 3000);
    prisma.$transaction = ((run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      transact(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        backendIds.add(pid);
        if (backendIds.size === 2) release();
        await gate;
        return run(tx);
      })) as typeof prisma.$transaction;

    try {
      const results = await Promise.all([fixture.recover(), fixture.recover()]);
      expect(backendIds.size).toBe(2);
      expect(results.map((result) => result.failed)).toEqual([0, 0]);
      expect(results.map((result) => result.recovered).sort()).toEqual([0, 1]);
    } finally {
      clearTimeout(timer);
      prisma.$transaction = original;
    }

    expect(await fixture.proposals()).toBe(1);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toHaveLength(1);
    expect(await fixture.recover()).toMatchObject({ recovered: 0, recoveryNeedsReview: 0 });
  });

  it.each([false, true])("fences the original worker after recovery or review (existing event = %s)", async (hasEvent) => {
    const fixture = await createDueStep("SEND_PAYMENT_REMINDER");
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    scenario.afterClaim = async () => { entered(); await gate; };
    const originalTick = fixture.tick();

    try {
      await Promise.race([reached, originalTick.then(() => { throw new Error("Worker did not reach the claim boundary"); })]);
      const [claim] = await fixture.executions();
      await prisma.collectionStepExecution.update({ where: { id: claim.id }, data: { claimedAt: staleClaimTime } });
      if (hasEvent) {
        await prisma.businessEvent.create({
          data: {
            ...fixture.scope, type: "COLLECTION_STEP_DUE", dedupeKey: claim.id,
            data: { stepAction: "SEND_PAYMENT_REMINDER" },
          },
        });
      }
      expect(await fixture.tick(recoveryNow)).toMatchObject({
        recovered: hasEvent ? 1 : 0, recoveryNeedsReview: hasEvent ? 0 : 1, failed: 0,
      });
    } finally {
      release();
      expect(await originalTick).toMatchObject({ claimed: 1, executed: 0, failed: 0 });
    }

    expect(await fixture.stepEvents()).toHaveLength(hasEvent ? 1 : 0);
    expect(await fixture.proposals()).toBe(hasEvent ? 1 : 0);
    expect(await fixture.auditEvents("COLLECTION_STEP_EXECUTED")).toHaveLength(hasEvent ? 1 : 0);
    expect(await fixture.auditEvents("COLLECTION_STEP_SKIPPED")).toHaveLength(hasEvent ? 0 : 1);
  });
});
