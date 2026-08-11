import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { recordPayment } from "@/server/ar/payments";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { approveActionProposal } from "@/server/operator/approval";
import { prepareReminderCommunication } from "@/server/communications/draft";
import { sendCommunication } from "@/server/communications/send";
import { createFakeEmailProvider } from "@/server/email/providers/fake";
import { runAutomationTick } from "./engine";
import { createCollectionPolicy, setCollectionPolicyEnabled, setDefaultCollectionPolicy, setOrganizationAutomationEnabled } from "./policy";
import { DEFAULT_POLICY_TEMPLATE } from "./policy-schema";
import { getCollectionStatusForInvoice } from "./sequences";

beforeEach(async () => {
  await resetDatabase();
});

describe("end-to-end: register -> org -> customer -> overdue invoice -> policy -> tick -> human action -> payment -> sequence stops", () => {
  it("runs the full Phase 5 collections automation pipeline with a deterministic fake provider and zero real network calls", async () => {
    // 1. Register + organization + customer, exactly as a real onboarding would.
    const { organization, user } = await createTestOrganization("E2E");
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });

    // 2. An overdue invoice already exists before automation is ever configured.
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-E2E-COLLECTIONS-1",
      currency: "USD",
      amountMinor: majorToMinor(1000),
      issueDate: "2026-01-01",
      dueDate: "2026-01-01",
    });

    // 3. Owner creates and enables the default policy, and turns on
    //    org-level automation — nothing has been sent yet.
    const policy = await createCollectionPolicy(organization.id, {
      name: DEFAULT_POLICY_TEMPLATE.name,
      steps: DEFAULT_POLICY_TEMPLATE.steps,
    });
    await setDefaultCollectionPolicy(organization.id, policy.id);
    await setCollectionPolicyEnabled(organization.id, policy.id, true);
    await setOrganizationAutomationEnabled(organization.id, true);

    expect(await prisma.communication.count()).toBe(0);

    // 4. First tick: enrolls the invoice. Day 0 is not yet overdue by even
    //    one day, so nothing is due.
    const enrollTick = await runAutomationTick(new Date("2026-01-01T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(enrollTick.enrolled).toBe(1);
    expect(enrollTick.executed).toBe(0);

    let status = await getCollectionStatusForInvoice(organization.id, invoice.id);
    expect(status).toMatchObject({ kind: "active", stepsCompleted: 0, stepCount: 4 });

    // 5. Second tick, one day later: the first step (day+1, SOFT) is due.
    //    The engine only ever *prepares* — a human must still act.
    const dueTick = await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(dueTick.executed).toBe(1);

    const proposal = await prisma.actionProposal.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(proposal.status).toBe("PENDING");
    expect(proposal.suggestedTone).toBe("soft");
    expect(await prisma.communication.count()).toBe(0); // still nothing sent

    status = await getCollectionStatusForInvoice(organization.id, invoice.id);
    expect(status).toMatchObject({ kind: "active", stepsCompleted: 1, stepCount: 4, nextStepDaysAfterDue: 3 });

    // 6. Human approves and sends via the existing, unmodified Phase 3/4 flow.
    const approved = await approveActionProposal(organization.id, proposal.id, user.id);
    const { communication } = await prepareReminderCommunication(organization.id, approved.id);
    const provider = createFakeEmailProvider({ kind: "success", providerMessageId: "e2e-msg-1" });
    const sendResult = await sendCommunication(organization.id, communication.id, user.id, { provider });
    expect(sendResult.communication.status).toBe("SENT");

    // 7. Customer pays in full.
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(1000), paidAt: "2026-01-03" });

    // 8. Next tick: the sequence self-heals to COMPLETED/PAID and sends
    //    nothing further, even though steps at day+3/+7/+14 are still
    //    "due" by date.
    const paidTick = await runAutomationTick(new Date("2026-01-20T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(paidTick.stopped).toBe(1);
    expect(paidTick.executed).toBe(0);

    const sequence = await prisma.collectionSequence.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(sequence.status).toBe("COMPLETED");
    expect(sequence.stopReason).toBe("PAID");

    status = await getCollectionStatusForInvoice(organization.id, invoice.id);
    expect(status).toMatchObject({ kind: "completed", stopReason: "PAID" });

    // 9. One more tick for good measure — still nothing, still one proposal, one communication.
    await runAutomationTick(new Date("2026-02-01T00:00:00.000Z"), { organizationId: organization.id });
    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(await prisma.communication.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });
});

describe("end-to-end: UNCERTAIN delivery blocks the next automated reminder until a human resolves it", () => {
  it("never sends a second automated reminder while the first one's outcome is unknown", async () => {
    const { organization, user } = await createTestOrganization("E2E-Uncertain");
    const customer = await createCustomer(organization.id, { name: "Beta Co", email: "ap@beta.example" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-E2E-UNCERTAIN-1",
      currency: "USD",
      amountMinor: majorToMinor(400),
      issueDate: "2026-01-01",
      dueDate: "2026-01-01",
    });

    const policy = await createCollectionPolicy(organization.id, {
      name: DEFAULT_POLICY_TEMPLATE.name,
      steps: DEFAULT_POLICY_TEMPLATE.steps,
    });
    await setDefaultCollectionPolicy(organization.id, policy.id);
    await setCollectionPolicyEnabled(organization.id, policy.id, true);
    await setOrganizationAutomationEnabled(organization.id, true);

    // Day+1 reminder becomes due, approved, and sent — but the provider
    // call itself times out/errors, leaving delivery UNCERTAIN.
    await runAutomationTick(new Date("2026-01-02T00:00:00.000Z"), { organizationId: organization.id });
    const proposal = await prisma.actionProposal.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    const approved = await approveActionProposal(organization.id, proposal.id, user.id);
    const { communication } = await prepareReminderCommunication(organization.id, approved.id);
    const flakyProvider = createFakeEmailProvider({ kind: "error", message: "ETIMEDOUT" });
    const sendResult = await sendCommunication(organization.id, communication.id, user.id, { provider: flakyProvider });
    expect(sendResult.communication.status).toBe("UNCERTAIN");

    // Day+3 and day+7 both become due — automation must not proceed.
    const blockedTick = await runAutomationTick(new Date("2026-01-09T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(blockedTick.blocked).toBe(1);
    expect(blockedTick.executed).toBe(0);
    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(await prisma.communication.count({ where: { invoiceId: invoice.id } })).toBe(1);

    const status = await getCollectionStatusForInvoice(organization.id, invoice.id);
    expect(status.kind).toBe("blocked_uncertain");

    // A human resolves it by manually resending (acknowledging the risk) —
    // once delivery is confirmed, the next tick is free to proceed again.
    const resendProvider = createFakeEmailProvider({ kind: "success", providerMessageId: "resolved-1" });
    const resent = await sendCommunication(organization.id, communication.id, user.id, {
      provider: resendProvider,
      acknowledgeUncertainRisk: true,
    });
    expect(resent.communication.status).toBe("SENT");

    const unblockedTick = await runAutomationTick(new Date("2026-01-10T00:00:00.000Z"), {
      organizationId: organization.id,
    });
    expect(unblockedTick.blocked).toBe(0);
    expect(unblockedTick.executed).toBe(1);
    expect(await prisma.actionProposal.count({ where: { invoiceId: invoice.id } })).toBe(2);
  });
});
