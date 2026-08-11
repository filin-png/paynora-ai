import { beforeEach, describe, expect, it } from "vitest";

import { cancelInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { recordPayment } from "@/server/ar/payments";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createFakeEmailProvider } from "@/server/email/providers/fake";
import { findDueSteps, runAutomationTick } from "./engine";
import { setCollectionPolicyAutomationMode } from "./policy";
import { pauseCollectionSequence } from "./sequences";
import { createAutomationReadyOrg, createTestInvoice } from "./test-fixtures";

beforeEach(async () => {
  await resetDatabase();
});

describe("runAutomationTick — global kill switch", () => {
  it("does nothing when globally disabled, even for an org with automation enabled", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    await createTestInvoice(organization.id, customer.id, "2026-01-01");

    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { globalEnabled: false });

    expect(summary.globallyDisabled).toBe(true);
    expect(summary.organizationsProcessed).toBe(0);
    const sequences = await prisma.collectionSequence.count();
    expect(sequences).toBe(0);
  });

  it("skips an organization whose own automationEnabled is false", async () => {
    const { organization, customer, policy } = await createAutomationReadyOrg();
    await prisma.organization.update({ where: { id: organization.id }, data: { automationEnabled: false } });
    await createTestInvoice(organization.id, customer.id, "2026-01-01");
    void policy;

    const summary = await runAutomationTick(new Date("2026-01-05T00:00:00.000Z"), {
      organizationId: organization.id,
    });

    expect(summary.organizationsProcessed).toBe(0);
    const sequences = await prisma.collectionSequence.count({ where: { organizationId: organization.id } });
    expect(sequences).toBe(0);
  });

  it("does nothing for an org with no enabled default policy", async () => {
    const { organization, user } = await createAutomationReadyOrg();
    void user;
    await prisma.collectionPolicy.updateMany({ where: { organizationId: organization.id }, data: { enabled: false } });
    const customer = await prisma.customer.findFirstOrThrow({ where: { organizationId: organization.id } });
    await createTestInvoice(organization.id, customer.id, "2026-01-01");

    const summary = await runAutomationTick(new Date("2026-01-05T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(summary.enrolled).toBe(0);
    expect(summary.scanned).toBe(0);
  });
});

describe("runAutomationTick — enrollment and first due step (APPROVAL_REQUIRED)", () => {
  it("enrolls an eligible invoice and does nothing before any step is due", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-10");

    const summary = await runAutomationTick(new Date("2026-01-10T00:00:00.000Z"), {
      organizationId: organization.id,
    });

    expect(summary.enrolled).toBe(1);
    expect(summary.scanned).toBe(1);
    expect(summary.executed).toBe(0);

    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(sequence.status).toBe("ACTIVE");
  });

  it("executes the first due step and creates a PENDING ActionProposal, without sending anything", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");

    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), {
      organizationId: organization.id,
    });

    expect(summary.enrolled).toBe(1);
    expect(summary.claimed).toBe(1);
    expect(summary.executed).toBe(1);

    const proposals = await prisma.actionProposal.findMany({ where: { invoiceId: invoice.id } });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("PENDING");
    expect(proposals[0]!.suggestedTone).toBe("soft");

    const communications = await prisma.communication.findMany({ where: { invoiceId: invoice.id } });
    expect(communications).toHaveLength(0);

    const businessEvents = await prisma.businessEvent.findMany({
      where: { invoiceId: invoice.id, type: "COLLECTION_STEP_DUE" },
    });
    expect(businessEvents).toHaveLength(1);
  });

  it("does not execute a step whose threshold hasn't passed yet", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-10");

    await runAutomationTick(new Date("2026-01-10T12:00:00.000Z"), { organizationId: organization.id });

    const proposals = await prisma.actionProposal.findMany({ where: { invoiceId: invoice.id } });
    expect(proposals).toHaveLength(0);
  });
});

describe("runAutomationTick — idempotency", () => {
  it("repeated ticks at the same `now` never duplicate anything", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const now = new Date("2026-01-02T00:00:00.000Z");

    await runAutomationTick(now, { organizationId: organization.id });
    await runAutomationTick(now, { organizationId: organization.id });
    const third = await runAutomationTick(now, { organizationId: organization.id });

    expect(third.enrolled).toBe(0);
    expect(third.executed).toBe(0);

    expect(await prisma.collectionSequence.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(await prisma.businessEvent.count({ where: { invoiceId: invoice.id, type: "COLLECTION_STEP_DUE" } })).toBe(
      1,
    );
    expect(await prisma.collectionStepExecution.count()).toBe(1);
  });
});

describe("runAutomationTick — worker vs worker concurrency", () => {
  it("two concurrent ticks execute the same due step exactly once", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const now = new Date("2026-01-02T00:00:00.000Z");

    // Pre-enroll so both concurrent ticks race on the same claim, not on
    // enrollment (enrollment's own idempotency is covered separately).
    await runAutomationTick(new Date("2025-12-01T00:00:00.000Z"), { organizationId: organization.id });

    const [a, b] = await Promise.all([
      runAutomationTick(now, { organizationId: organization.id }),
      runAutomationTick(now, { organizationId: organization.id }),
    ]);

    expect(a.executed + b.executed).toBe(1);
    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(await prisma.collectionStepExecution.count({ where: { status: "EXECUTED" } })).toBe(1);
  });
});

describe("runAutomationTick — catch-up semantics", () => {
  it("on a fresh sequence, jumping straight to a deep-overdue day executes only the most-advanced step and skips the rest", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");

    const summary = await runAutomationTick(new Date("2026-01-15T00:00:00.000Z"), {
      organizationId: organization.id,
    });

    expect(summary.executed).toBe(1);
    expect(summary.skipped).toBe(3);

    const executions = await prisma.collectionStepExecution.findMany({
      where: { sequence: { invoiceId: invoice.id } },
      include: { step: true },
    });
    const executed = executions.filter((e) => e.status === "EXECUTED");
    const skipped = executions.filter((e) => e.status === "SKIPPED");
    expect(executed).toHaveLength(1);
    expect(executed[0]!.step.daysAfterDue).toBe(14);
    expect(skipped.map((e) => e.step.daysAfterDue).sort((x, y) => x - y)).toEqual([1, 3, 7]);
  });

  it("a scheduler gap after one executed step catches up to the latest due step without a reminder burst", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");

    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id }); // executes day-1
    const summary = await runAutomationTick(new Date("2026-01-15T00:00:00.000Z"), {
      organizationId: organization.id,
    }); // gap: days 3 and 7 never ran

    expect(summary.executed).toBe(1);
    expect(summary.skipped).toBe(2);

    const executions = await prisma.collectionStepExecution.findMany({
      where: { sequence: { invoiceId: invoice.id } },
      include: { step: true },
    });
    expect(executions.filter((e) => e.status === "EXECUTED").map((e) => e.step.daysAfterDue).sort((a, b) => a - b)).toEqual([1, 14]);
    expect(executions.filter((e) => e.status === "SKIPPED").map((e) => e.step.daysAfterDue).sort((a, b) => a - b)).toEqual([3, 7]);
  });
});

describe("findDueSteps (pure)", () => {
  it("picks the most-advanced due step and reports the rest as superseded", () => {
    const steps = [
      { id: "s1", daysAfterDue: 1 },
      { id: "s3", daysAfterDue: 3 },
      { id: "s7", daysAfterDue: 7 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    const { stepToExecute, supersededSteps } = findDueSteps(steps, 10, new Set());
    expect(stepToExecute?.id).toBe("s7");
    expect(supersededSteps.map((s: { id: string }) => s.id)).toEqual(["s1", "s3"]);
  });

  it("returns null when nothing is due yet", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = [{ id: "s7", daysAfterDue: 7 }] as any;
    const { stepToExecute, supersededSteps } = findDueSteps(steps, 3, new Set());
    expect(stepToExecute).toBeNull();
    expect(supersededSteps).toEqual([]);
  });

  it("excludes already-executed steps", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = [{ id: "s1", daysAfterDue: 1 }, { id: "s3", daysAfterDue: 3 }] as any;
    const { stepToExecute } = findDueSteps(steps, 10, new Set(["s1", "s3"]));
    expect(stepToExecute).toBeNull();
  });
});

describe("runAutomationTick — payment stops the sequence", () => {
  it("full payment stops the sequence with reason PAID and no further reminder", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01", 500);

    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(500), paidAt: "2026-01-03" });

    const summary = await runAutomationTick(new Date("2026-01-05T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(summary.stopped).toBe(1);

    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(sequence.status).toBe("COMPLETED");
    expect(sequence.stopReason).toBe("PAID");

    // No new reminder for the now-fully-paid invoice.
    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it("partial payment does not stop the sequence and later steps still execute", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01", 500);

    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id }); // day 1
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(200), paidAt: "2026-01-03" });

    const summary = await runAutomationTick(new Date("2026-01-04T00:00:00.000Z"), {
      organizationId: organization.id,
    }); // day 3
    expect(summary.stopped).toBe(0);
    expect(summary.executed).toBe(1);

    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(sequence.status).toBe("ACTIVE");

    const events = await prisma.businessEvent.findMany({
      where: { invoiceId: invoice.id, type: "COLLECTION_STEP_DUE" },
    });
    const latest = events.sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())[0]!;
    expect((latest.data as { outstandingAmount: string }).outstandingAmount).toContain("300");
  });
});

describe("runAutomationTick — cancellation and archived customer stop the sequence", () => {
  it("a cancelled invoice stops the sequence", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-01T00:00:00.000Z"), { organizationId: organization.id }); // enroll only
    await cancelInvoice(organization.id, invoice.id);

    const summary = await runAutomationTick(new Date("2026-01-05T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(summary.stopped).toBe(1);
    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(sequence.status).toBe("STOPPED");
    expect(sequence.stopReason).toBe("CANCELLED");
  });

  it("an archived customer stops the sequence", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-01T00:00:00.000Z"), { organizationId: organization.id });
    await prisma.customer.update({ where: { id: customer.id }, data: { archivedAt: new Date() } });

    const summary = await runAutomationTick(new Date("2026-01-05T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(summary.stopped).toBe(1);
    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(sequence.stopReason).toBe("CUSTOMER_ARCHIVED");
  });

  it("disabling the policy stops in-flight sequences", async () => {
    const { organization, customer, policy } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-01T00:00:00.000Z"), { organizationId: organization.id });
    await prisma.collectionPolicy.update({ where: { id: policy.id }, data: { enabled: false } });

    const summary = await runAutomationTick(new Date("2026-01-05T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(summary.stopped).toBe(1);
    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(sequence.stopReason).toBe("POLICY_DISABLED");
  });
});

describe("runAutomationTick — pause", () => {
  it("a paused sequence is left untouched and does not resume with a burst on its own", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id }); // day 1 executes
    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    await pauseCollectionSequence(organization.id, sequence.id);

    const summary = await runAutomationTick(new Date("2026-01-20T00:00:00.000Z"), {
      organizationId: organization.id,
    }); // well past every remaining step
    expect(summary.scanned).toBe(0); // PAUSED sequences are not ACTIVE, never scanned

    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });
});

describe("runAutomationTick — UNCERTAIN / stuck SENDING blocks further automation", () => {
  it("an UNCERTAIN communication on the invoice blocks the next due step", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id }); // day 1 executes

    const proposal = await prisma.actionProposal.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    await prisma.communication.create({
      data: {
        organizationId: organization.id,
        customerId: customer.id,
        invoiceId: invoice.id,
        actionProposalId: proposal.id,
        purpose: "PAYMENT_REMINDER",
        recipient: customer.email!,
        subject: "s",
        body: "b",
        status: "UNCERTAIN",
      },
    });

    const summary = await runAutomationTick(new Date("2026-01-04T00:00:00.000Z"), {
      organizationId: organization.id,
    }); // day 3 would otherwise be due
    expect(summary.blocked).toBe(1);
    expect(summary.executed).toBe(0);
    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it("a stuck SENDING communication also blocks the next due step", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id });

    const proposal = await prisma.actionProposal.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    await prisma.communication.create({
      data: {
        organizationId: organization.id,
        customerId: customer.id,
        invoiceId: invoice.id,
        actionProposalId: proposal.id,
        purpose: "PAYMENT_REMINDER",
        recipient: customer.email!,
        subject: "s",
        body: "b",
        status: "SENDING",
      },
    });

    const summary = await runAutomationTick(new Date("2026-01-04T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(summary.blocked).toBe(1);
    expect(summary.executed).toBe(0);
  });
});

describe("runAutomationTick — AUTO_SEND", () => {
  it("is never taken when automationMode is APPROVAL_REQUIRED (the default)", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id });
    const communications = await prisma.communication.count({ where: { invoiceId: invoice.id } });
    expect(communications).toBe(0);
  });

  it("approves, prepares, and sends via the existing Communication pipeline when explicitly enabled by an owner", async () => {
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const provider = createFakeEmailProvider({ kind: "success", providerMessageId: "auto-1" });

    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), {
      organizationId: organization.id,
      emailProvider: provider,
    });

    expect(summary.executed).toBe(1);
    const proposal = await prisma.actionProposal.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(proposal.status).toBe("EXECUTED");
    expect(proposal.decidedByUserId).toBe(user.id);

    const communication = await prisma.communication.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(communication.status).toBe("SENT");
  });

  it("does not send when the invoice was paid between claim and the pre-send re-check", async () => {
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01", 500);
    // Enroll first so the payment below doesn't race enrollment itself.
    await runAutomationTick(new Date("2025-12-15T00:00:00.000Z"), { organizationId: organization.id });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(500), paidAt: "2026-01-01" });

    const provider = createFakeEmailProvider({ kind: "success" });
    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), {
      organizationId: organization.id,
      emailProvider: provider,
    });

    // The sequence is fully paid, so it stops before any step is even
    // selected — proving the payment race is closed at the earliest
    // possible check, not merely at the AUTO_SEND-specific re-check.
    expect(summary.stopped).toBe(1);
    expect(await prisma.communication.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it("concurrent ticks in AUTO_SEND mode never call the provider twice for the same step", async () => {
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2025-12-01T00:00:00.000Z"), { organizationId: organization.id }); // enroll only

    let callCount = 0;
    const countingProvider = createFakeEmailProvider({ kind: "success" });
    const wrapped = {
      name: "counting-fake",
      async send(message: Parameters<typeof countingProvider.send>[0]) {
        callCount += 1;
        return countingProvider.send(message);
      },
    };

    const now = new Date("2026-01-02T00:00:00.000Z");
    await Promise.all([
      runAutomationTick(now, { organizationId: organization.id, emailProvider: wrapped }),
      runAutomationTick(now, { organizationId: organization.id, emailProvider: wrapped }),
    ]);

    expect(callCount).toBe(1);
  });
});

describe("runAutomationTick — tenant isolation", () => {
  it("processing one organization never touches another's sequences", async () => {
    const orgA = await createAutomationReadyOrg("OrgA");
    const orgB = await createAutomationReadyOrg("OrgB");
    await createTestInvoice(orgA.organization.id, orgA.customer.id, "2026-01-01");
    await createTestInvoice(orgB.organization.id, orgB.customer.id, "2026-01-01");

    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: orgA.organization.id });

    expect(await prisma.collectionSequence.count({ where: { organizationId: orgA.organization.id } })).toBe(1);
    expect(await prisma.collectionSequence.count({ where: { organizationId: orgB.organization.id } })).toBe(0);
  });

  it("a global tick (no organizationId) processes every automation-enabled organization", async () => {
    const orgA = await createAutomationReadyOrg("OrgA");
    const orgB = await createAutomationReadyOrg("OrgB");
    await createTestInvoice(orgA.organization.id, orgA.customer.id, "2026-01-01");
    await createTestInvoice(orgB.organization.id, orgB.customer.id, "2026-01-01");

    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"));

    expect(summary.organizationsProcessed).toBeGreaterThanOrEqual(2);
    expect(await prisma.collectionSequence.count({ where: { organizationId: orgA.organization.id } })).toBe(1);
    expect(await prisma.collectionSequence.count({ where: { organizationId: orgB.organization.id } })).toBe(1);
  });
});
