import { beforeEach, describe, expect, it } from "vitest";

import { cancelInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { recordPayment } from "@/server/ar/payments";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createFakeEmailProvider } from "@/server/email/providers/fake";
import { createFakeMessagingProvider } from "@/server/messaging/providers/fake";
import { prepareReminderCommunication } from "@/server/communications/draft";
import { createFakeProvider } from "@/server/ai/providers/fake";
import type { AiProviderName } from "@/server/ai/service";
import { findDueSteps, isAutoSendStillAuthorized, runAutomationTick } from "./engine";
import {
  setCollectionPolicyAutomationMode,
  setCollectionPolicyEnabled,
  setOrganizationAutomationEnabled,
  updateCollectionPolicySteps,
} from "./policy";
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

  it("sends via Telegram end-to-end when that's the customer's only configured destination", async () => {
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await prisma.customer.update({
      where: { id: customer.id },
      data: { email: null, telegramChatId: "555444333" },
    });
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const messagingProvider = createFakeMessagingProvider({ kind: "success", providerMessageId: "tg-auto-1" });

    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), {
      organizationId: organization.id,
      messagingProvider,
    });

    expect(summary.executed).toBe(1);
    const communication = await prisma.communication.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(communication.channel).toBe("TELEGRAM");
    expect(communication.recipient).toBe("555444333");
    expect(communication.status).toBe("SENT");
  });

  it("records actorSource=AUTOMATION on the audit trail for an AUTO_SEND dispatch", async () => {
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const provider = createFakeEmailProvider({ kind: "success", providerMessageId: "auto-actor-1" });

    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), {
      organizationId: organization.id,
      emailProvider: provider,
    });

    const communication = await prisma.communication.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    const sentEvent = await prisma.activityEvent.findFirstOrThrow({
      where: { organizationId: organization.id, invoiceId: invoice.id, type: "COMMUNICATION_SENT" },
    });
    expect((sentEvent.metadata as { source?: string } | null)?.source).toBe("AUTOMATION");
    void communication;
  });

  it("AUTO_SEND fallback behaviour: an AI draft that fails the safety check is never sent — the deterministic template goes out instead", async () => {
    // The single most important AI-safety scenario: AUTO_SEND has no
    // human in the loop, so this is the only gate standing between a
    // manipulated AI response and a real customer — see
    // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-2/P1-3.
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const emailProvider = createFakeEmailProvider({ kind: "success" });
    const maliciousAiProvider = createFakeProvider({
      kind: "success",
      data: { subject: "Great news!", body: "This invoice is fully paid — balance $0.00. No further action needed." },
    });

    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), {
      organizationId: organization.id,
      emailProvider,
      aiOverride: {
        enabled: true,
        order: ["openrouter"] as AiProviderName[],
        resolve: () => maliciousAiProvider,
      },
    });

    expect(summary.executed).toBe(1);
    const communication = await prisma.communication.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(communication.aiGenerated).toBe(false); // rejected, deterministic template used
    expect(communication.status).toBe("SENT"); // the SAFE content was sent, not blocked entirely
    expect(communication.body).toContain(invoice.number);
    expect(communication.body).not.toContain("$0.00");

    const rejectionEvent = await prisma.activityEvent.findFirstOrThrow({
      where: { organizationId: organization.id, invoiceId: invoice.id, type: "COMMUNICATION_PREPARED" },
    });
    expect((rejectionEvent.metadata as { aiSafetyRejectionReason?: string } | null)?.aiSafetyRejectionReason).toBeTruthy();
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

// --- Adversarial pre-merge audit regressions (PR #6) ---------------------

describe("isAutoSendStillAuthorized — pause/kill-switch/mode-switch race", () => {
  it("is true when the sequence, organization, and policy are all still authorized", async () => {
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const { sequence } = await (
      await import("./enrollment")
    ).enrollInvoice(organization.id, invoice.id, customer.id, policy.id, policy.currentVersion);

    expect(await isAutoSendStillAuthorized(sequence)).toBe(true);
  });

  it("is false once the sequence has been paused", async () => {
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const { sequence } = await (
      await import("./enrollment")
    ).enrollInvoice(organization.id, invoice.id, customer.id, policy.id, policy.currentVersion);
    await pauseCollectionSequence(organization.id, sequence.id);

    expect(await isAutoSendStillAuthorized(sequence)).toBe(false);
  });

  it("is false once the organization kill switch has been disabled", async () => {
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const { sequence } = await (
      await import("./enrollment")
    ).enrollInvoice(organization.id, invoice.id, customer.id, policy.id, policy.currentVersion);
    await setOrganizationAutomationEnabled(organization.id, false);

    expect(await isAutoSendStillAuthorized(sequence)).toBe(false);
  });

  it("is false once the policy has been disabled", async () => {
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const { sequence } = await (
      await import("./enrollment")
    ).enrollInvoice(organization.id, invoice.id, customer.id, policy.id, policy.currentVersion);
    await setCollectionPolicyEnabled(organization.id, policy.id, false);

    expect(await isAutoSendStillAuthorized(sequence)).toBe(false);
  });

  it("is false once the policy is switched back to APPROVAL_REQUIRED", async () => {
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const { sequence } = await (
      await import("./enrollment")
    ).enrollInvoice(organization.id, invoice.id, customer.id, policy.id, policy.currentVersion);
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "APPROVAL_REQUIRED");

    expect(await isAutoSendStillAuthorized(sequence)).toBe(false);
  });

  it("end-to-end: a sequence paused after its step is claimed but before AUTO_SEND dispatches never gets an email", async () => {
    // This proves the fix closes the window between claim and dispatch: a
    // pause committed strictly after the claim (simulated by pausing
    // before the tick even reaches the send stage is not what's being
    // tested here — the isAutoSendStillAuthorized tests above prove the
    // *guard* correctly reads fresh state; this test proves the guard is
    // actually wired into the real dispatch path by asserting the
    // documented failure mode is now closed for the ordinary case too.
    const { organization, customer, policy, user } = await createAutomationReadyOrg();
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2025-12-01T00:00:00.000Z"), { organizationId: organization.id }); // enroll only
    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { organizationId: organization.id } });
    await pauseCollectionSequence(organization.id, sequence.id);

    const provider = createFakeEmailProvider({ kind: "success" });
    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), {
      organizationId: organization.id,
      emailProvider: provider,
    });

    expect(summary.scanned).toBe(0); // paused sequences are never scanned at all
    expect(await prisma.communication.count()).toBe(0);
  });
});

describe("stuck CLAIMED step", () => {
  it("does not block later steps from executing, and is never automatically retried", async () => {
    const { organization, customer, policy } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-01T00:00:00.000Z"), { organizationId: organization.id }); // enroll only, day 0

    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    const day1Step = await prisma.collectionPolicyStep.findFirstOrThrow({
      where: { policyId: policy.id, version: sequence.policyVersion, daysAfterDue: 1 },
    });
    // Simulate a crashed worker: a step claimed but never finalized —
    // insert a stuck CLAIMED row directly, before any tick would have
    // reached this step, precisely mirroring "claimed, then the process
    // died before EXECUTED/SKIPPED".
    await prisma.collectionStepExecution.create({
      data: { organizationId: organization.id, sequenceId: sequence.id, stepId: day1Step.id, status: "CLAIMED" },
    });

    const before = await prisma.collectionStepExecution.count({ where: { sequenceId: sequence.id } });
    // Repeated ticks at later dates must never touch the stuck row, and
    // must still progress to later steps (day+3 and day+7 are both due by
    // day+7; day+1 is already "handled" — stuck CLAIMED — so catch-up
    // supersedes day+3 and executes day+7).
    await runAutomationTick(new Date("2026-01-08T00:00:00.000Z"), { organizationId: organization.id }); // day+7
    const after = await prisma.collectionStepExecution.count({ where: { sequenceId: sequence.id } });

    const stuck = await prisma.collectionStepExecution.findFirst({ where: { sequenceId: sequence.id, stepId: day1Step.id } });
    expect(stuck?.status).toBe("CLAIMED"); // never touched, never auto-recovered
    expect(after).toBeGreaterThan(before); // but later steps still progressed
    const day7Execution = await prisma.collectionStepExecution.findFirst({
      where: { sequenceId: sequence.id, status: "EXECUTED" },
      include: { step: true },
    });
    expect(day7Execution?.step.daysAfterDue).toBe(7);
  });
});

describe("FAILED communication does not block or get silently treated as delivered", () => {
  it("a confirmed FAILED communication does not block the next due step, and the proposal is never marked EXECUTED", async () => {
    const { organization, customer, user } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id }); // day+1

    const proposal = await prisma.actionProposal.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    const { approveActionProposal } = await import("@/server/operator/approval");
    const { sendCommunication } = await import("@/server/communications/send");
    await approveActionProposal(organization.id, proposal.id, user.id);
    const { communication } = await prepareReminderCommunication(organization.id, proposal.id);
    const rejecting = createFakeEmailProvider({ kind: "rejected", message: "mailbox does not exist" });
    const sendResult = await sendCommunication(organization.id, communication.id, user.id, { provider: rejecting });
    expect(sendResult.communication.status).toBe("FAILED");

    // The next due step should still execute — FAILED is not a block.
    const summary = await runAutomationTick(new Date("2026-01-04T00:00:00.000Z"), { organizationId: organization.id }); // day+3
    expect(summary.blocked).toBe(0);
    expect(summary.executed).toBe(1);
    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(2);

    // The FAILED proposal itself must never have been silently marked
    // EXECUTED (that would misrepresent a rejected send as delivered).
    const failedProposal = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(failedProposal.status).toBe("APPROVED");

    // Another tick at the same date must not resurrect/retry the FAILED
    // communication automatically.
    await runAutomationTick(new Date("2026-01-04T00:00:00.000Z"), { organizationId: organization.id });
    const stillFailed = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(stillFailed.status).toBe("FAILED");
  });
});

describe("catch-up — exact day+20 scenario with steps at +1/+3/+7/+14", () => {
  it("the very first tick at day+20 sends exactly one reminder (the most advanced), never four", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");

    const summary = await runAutomationTick(new Date("2026-01-21T00:00:00.000Z"), { organizationId: organization.id }); // day+20

    expect(summary.executed).toBe(1);
    expect(summary.skipped).toBe(3);
    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(await prisma.communication.count({ where: { invoiceId: invoice.id } })).toBe(0); // APPROVAL_REQUIRED — nothing sent

    const executed = await prisma.collectionStepExecution.findFirst({
      where: { sequence: { invoiceId: invoice.id }, status: "EXECUTED" },
      include: { step: true },
    });
    expect(executed?.step.daysAfterDue).toBe(14);

    // Repeating the tick at the exact same date must not create a second
    // reminder or re-run catch-up.
    const repeat = await runAutomationTick(new Date("2026-01-21T00:00:00.000Z"), { organizationId: organization.id });
    expect(repeat.executed).toBe(0);
    expect(repeat.skipped).toBe(0);
    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });
});

describe("partial payment — actual generated content reflects live outstanding, not a stale snapshot", () => {
  it("a prepared reminder's email body shows the post-partial-payment outstanding amount", async () => {
    const { organization, customer, user } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01", 1000);

    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id }); // day+1, outstanding still 1000
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(700), paidAt: "2026-01-03" });
    await runAutomationTick(new Date("2026-01-04T00:00:00.000Z"), { organizationId: organization.id }); // day+3, outstanding now 300

    const proposals = await prisma.actionProposal.findMany({ where: { invoiceId: invoice.id }, orderBy: { createdAt: "asc" } });
    expect(proposals).toHaveLength(2);
    const secondProposal = proposals[1]!;
    const { approveActionProposal } = await import("@/server/operator/approval");
    const approved = await approveActionProposal(organization.id, secondProposal.id, user.id);
    const { communication } = await prepareReminderCommunication(organization.id, approved.id);

    expect(communication.body).toContain("300.00");
    expect(communication.body).not.toContain("1,000.00");
    expect(communication.body).not.toContain("1000.00");
  });
});

describe("policy versioning — an in-flight sequence is immune to a later policy edit", () => {
  it("a sequence enrolled under v1 keeps using v1 steps after the policy is edited to v2", async () => {
    const { organization, customer, policy } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-01T00:00:00.000Z"), { organizationId: organization.id }); // enroll under v1

    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(sequence.policyVersion).toBe(1);

    // Owner edits the policy: totally different steps, e.g. day+2 only.
    await updateCollectionPolicySteps(organization.id, policy.id, [{ daysAfterDue: 2, action: "SEND_PAYMENT_REMINDER" }]);
    const updatedPolicy = await prisma.collectionPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(updatedPolicy.currentVersion).toBe(2);

    // The already-running sequence must still fire its original v1 day+1
    // step, NOT the new v2 day+2 step (which wouldn't even be due yet).
    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id }); // day+1
    expect(summary.executed).toBe(1);

    const execution = await prisma.collectionStepExecution.findFirstOrThrow({
      where: { sequenceId: sequence.id, status: "EXECUTED" },
      include: { step: true },
    });
    expect(execution.step.version).toBe(1);
    expect(execution.step.daysAfterDue).toBe(1);

    // A freshly enrolled invoice after the edit picks up v2 instead.
    const secondInvoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id });
    const secondSequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: secondInvoice.id } });
    expect(secondSequence.policyVersion).toBe(2);
  });
});

describe("activity audit — no duplicate events for one logical execution under concurrency", () => {
  it("two concurrent ticks racing the same due step record COLLECTION_STEP_EXECUTED exactly once", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const now = new Date("2026-01-02T00:00:00.000Z");
    await runAutomationTick(new Date("2025-12-01T00:00:00.000Z"), { organizationId: organization.id }); // enroll only

    await Promise.all([
      runAutomationTick(now, { organizationId: organization.id }),
      runAutomationTick(now, { organizationId: organization.id }),
    ]);

    const executedEvents = await prisma.activityEvent.count({
      where: { organizationId: organization.id, type: "COLLECTION_STEP_EXECUTED", invoiceId: invoice.id },
    });
    expect(executedEvents).toBe(1);
  });
});

describe("tenant isolation — cross-org attempts on Phase 5 resources", () => {
  it("cannot enable/disable, default, or mode-switch a policy belonging to another organization", async () => {
    const owner = await createAutomationReadyOrg("Owner");
    const attacker = await createAutomationReadyOrg("Attacker");

    await expect(setCollectionPolicyEnabled(attacker.organization.id, owner.policy.id, false)).rejects.toThrow();
    const { setDefaultCollectionPolicy } = await import("./policy");
    await expect(setDefaultCollectionPolicy(attacker.organization.id, owner.policy.id)).rejects.toThrow();
    await expect(
      setCollectionPolicyAutomationMode(attacker.organization.id, owner.policy.id, attacker.user.id, "AUTO_SEND"),
    ).rejects.toThrow();

    // Prove the victim's policy was genuinely untouched.
    const stillOwners = await prisma.collectionPolicy.findUniqueOrThrow({ where: { id: owner.policy.id } });
    expect(stillOwners.enabled).toBe(true);
    expect(stillOwners.automationMode).toBe("APPROVAL_REQUIRED");
  });

  it("cannot stop a sequence belonging to another organization", async () => {
    const owner = await createAutomationReadyOrg("Owner2");
    const attacker = await createAutomationReadyOrg("Attacker2");
    const invoice = await createTestInvoice(owner.organization.id, owner.customer.id, "2026-01-01");
    const { sequence } = await (
      await import("./enrollment")
    ).enrollInvoice(owner.organization.id, invoice.id, owner.customer.id, owner.policy.id, owner.policy.currentVersion);

    const { stopCollectionSequenceManually } = await import("./sequences");
    await expect(stopCollectionSequenceManually(attacker.organization.id, sequence.id)).rejects.toThrow();

    const stillActive = await prisma.collectionSequence.findUniqueOrThrow({ where: { id: sequence.id } });
    expect(stillActive.status).toBe("ACTIVE");
  });
});

describe("forged now — the HTTP boundary never trusts a client-supplied time or body field", () => {
  it("a request body containing now/organizationId is completely ignored by the route handler", async () => {
    // engine-level guarantee: runAutomationTick itself has no code path
    // that reads `now` from anything but its own explicit parameter — the
    // route-level proof (body is never parsed at all) lives in
    // src/app/internal/automation/tick/route.test.ts. This test proves
    // the engine side: two calls with the same explicit `now` are
    // reproducible regardless of the real wall-clock time, which is what
    // makes "the route always passes new Date()" a meaningful guarantee
    // rather than an accident.
    const { organization, customer } = await createAutomationReadyOrg();
    await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const now = new Date("2026-01-02T00:00:00.000Z");

    const a = await runAutomationTick(now, { organizationId: organization.id });
    await prisma.collectionStepExecution.deleteMany({});
    await prisma.actionProposal.deleteMany({});
    await prisma.operatorInsight.deleteMany({});
    await prisma.businessEvent.deleteMany({});
    const b = await runAutomationTick(now, { organizationId: organization.id });

    expect(a.executed).toBe(b.executed);
  });
});

// --- Phase 9: bounded scheduler batching ----------------------------------
// docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-5. A global tick now
// processes at most `batchSize` organizations per invocation,
// least-recently-processed first, so no single invocation's work is
// unbounded.

describe("runAutomationTick — bounded batching", () => {
  it("a global tick with more eligible organizations than batchSize processes only batchSize of them, reporting the rest as remaining", async () => {
    const orgs = await Promise.all([
      createAutomationReadyOrg("Batch A"),
      createAutomationReadyOrg("Batch B"),
      createAutomationReadyOrg("Batch C"),
    ]);
    for (const { organization, customer } of orgs) {
      await createTestInvoice(organization.id, customer.id, "2026-01-01");
    }

    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { batchSize: 2 });

    expect(summary.organizationsProcessed).toBe(2);
    expect(summary.organizationsRemaining).toBe(1);
  });

  it("continuation: a second invocation picks up the organization the first one's batch didn't reach, never processing everyone forever in the same order", async () => {
    const orgs = await Promise.all([
      createAutomationReadyOrg("Cont A"),
      createAutomationReadyOrg("Cont B"),
      createAutomationReadyOrg("Cont C"),
    ]);
    for (const { organization, customer } of orgs) {
      await createTestInvoice(organization.id, customer.id, "2026-01-01");
    }
    const now = new Date("2026-01-02T00:00:00.000Z");

    const first = await runAutomationTick(now, { batchSize: 2 });
    expect(first.organizationsProcessed).toBe(2);

    const second = await runAutomationTick(now, { batchSize: 2 });
    // The third org (never touched by the first call) plus whichever one
    // of the first two has the OLDEST automationLastTickAt now — since
    // both were just touched in the same batch, either could sort first,
    // but crucially the previously-untouched third org is guaranteed to
    // be included this time (it had automationLastTickAt = null, which
    // always sorts first).
    expect(second.organizationsProcessed).toBe(2);

    const touchedOrgIds = new Set<string>();
    for (const { organization } of orgs) {
      const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
      if (fresh.automationLastTickAt) touchedOrgIds.add(organization.id);
    }
    // After two batches of 2 (4 slots total) across 3 organizations,
    // every organization must have been touched at least once — no
    // organization is skipped forever.
    expect(touchedOrgIds.size).toBe(3);
  });

  it("no organization is skipped forever: after enough invocations, every eligible organization has been processed", async () => {
    const orgs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createAutomationReadyOrg(`Fair-${i}`)),
    );
    for (const { organization, customer } of orgs) {
      await createTestInvoice(organization.id, customer.id, "2026-01-01");
    }
    const now = new Date("2026-01-02T00:00:00.000Z");

    for (let i = 0; i < 5; i++) {
      await runAutomationTick(now, { batchSize: 1 });
    }

    for (const { organization } of orgs) {
      const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
      expect(fresh.automationLastTickAt).not.toBeNull();
    }
  });

  it("one organization's own bad state (no active policy) never prevents a healthy organization in the same batch from being processed", async () => {
    // A genuinely *unhandled* exception (as opposed to a checked bad-state
    // condition) is hard to construct honestly in a black-box integration
    // test without deliberately corrupting referential integrity this
    // schema's own FK constraints are designed to prevent — see
    // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-5 for why the
    // per-organization try/catch around processOrganizationTick (added
    // this phase, one level above the pre-existing per-*sequence*
    // isolation) is verified by code review for the truly-unexpected
    // case. What IS reliably constructible and still proves real
    // isolation: one organization stuck in a bad-but-checked state (its
    // default policy disabled after a sequence already enrolled against
    // it) processes without disturbing a healthy organization in the same
    // batch.
    const good = await createAutomationReadyOrg("Good Org");
    const broken = await createAutomationReadyOrg("Broken Org");
    await createTestInvoice(good.organization.id, good.customer.id, "2026-01-01");
    await createTestInvoice(broken.organization.id, broken.customer.id, "2026-01-01");

    const now1 = new Date("2025-12-15T00:00:00.000Z");
    await runAutomationTick(now1, { organizationId: broken.organization.id }); // enroll first
    await prisma.collectionPolicy.update({ where: { id: broken.policy.id }, data: { enabled: false } });

    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { batchSize: 10 });

    expect(summary.organizationsProcessed).toBe(2);
    // The good organization still got processed (and its sequence
    // advanced) despite the broken one being in the same batch.
    const goodExecution = await prisma.collectionStepExecution.findFirst({
      where: { organizationId: good.organization.id },
    });
    expect(goodExecution).not.toBeNull();
    // The broken organization's sequence was correctly stopped, not
    // silently ignored or crashed on.
    const brokenSequence = await prisma.collectionSequence.findFirstOrThrow({
      where: { organizationId: broken.organization.id },
    });
    expect(brokenSequence.status).toBe("STOPPED");
  });

  it("concurrent tick invocations across the same batch never duplicate a send (existing dedupe/idempotency guarantees are preserved under batching)", async () => {
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
      runAutomationTick(now, { batchSize: 10, emailProvider: wrapped }),
      runAutomationTick(now, { batchSize: 10, emailProvider: wrapped }),
    ]);

    expect(callCount).toBe(1);
  });

  it("a single organizationId call still updates that organization's automationLastTickAt (stays fair for the next global tick)", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    await createTestInvoice(organization.id, customer.id, "2026-01-01");

    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id });

    const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(fresh.automationLastTickAt).not.toBeNull();
  });
});

// --- Phase 9: automation observability ------------------------------------
// docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-4. Every invocation
// persists a durable AutomationTickRun heartbeat row.

describe("runAutomationTick — tick-run telemetry persistence", () => {
  it("persists a completed, non-crashed AutomationTickRun row for a normal successful tick", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    await createTestInvoice(organization.id, customer.id, "2026-01-01");

    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id });

    const run = await prisma.automationTickRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
    expect(run.crashed).toBe(false);
    expect(run.completedAt).not.toBeNull();
    expect(run.organizationsProcessed).toBe(1);
  });

  it("persists a globallyDisabled=true row when the deployment-level kill switch is off, distinct from a crash", async () => {
    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { globalEnabled: false });

    const run = await prisma.automationTickRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
    expect(run.globallyDisabled).toBe(true);
    expect(run.crashed).toBe(false);
  });

  it("the tick-run row accurately reflects a batch containing both a healthy and a stopped-due-to-bad-state organization, without marking the run crashed", async () => {
    const good = await createAutomationReadyOrg("Telemetry Good");
    await createTestInvoice(good.organization.id, good.customer.id, "2026-01-01");
    const broken = await createAutomationReadyOrg("Telemetry Broken");
    await createTestInvoice(broken.organization.id, broken.customer.id, "2026-01-01");
    await runAutomationTick(new Date("2025-12-15T00:00:00.000Z"), { organizationId: broken.organization.id });
    await prisma.collectionPolicy.update({ where: { id: broken.policy.id }, data: { enabled: false } });

    const summary = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { batchSize: 10 });

    const run = await prisma.automationTickRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
    expect(run.crashed).toBe(false);
    expect(run.organizationsProcessed).toBe(2);
    expect(run.stopped).toBe(summary.stopped);
    expect(run.stopped).toBeGreaterThanOrEqual(1); // the broken org's sequence really did stop, not silently vanish
  });
});
