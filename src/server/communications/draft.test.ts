import { beforeEach, describe, expect, it } from "vitest";

import { approveActionProposal } from "@/server/operator/approval";
import { detectInvoiceOverdueEvents } from "@/server/operator/events";
import { ensureInsightForInvoiceOverdueEvent } from "@/server/operator/insights";
import { ensureReminderProposalForInsight } from "@/server/operator/proposals";
import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createFakeProvider } from "@/server/ai/providers/fake";
import type { AiProviderName } from "@/server/ai/service";
import { checkRateLimit } from "@/server/rate-limit/service";
import { aiGenerationPolicy } from "@/server/rate-limit/policies";
import { getCommunicationForProposal, prepareReminderCommunication } from "./draft";
import { CommunicationChannelBlockedError, InvalidActionProposalForCommunicationError } from "./errors";

beforeEach(async () => {
  await resetDatabase();
});

async function createApprovedProposal(
  organizationId: string,
  userId: string,
  customerId: string,
  dueDate = "2020-01-15",
) {
  const invoice = await createInvoice(organizationId, {
    customerId,
    number: `INV-${Math.random().toString(36).slice(2, 8)}`,
    currency: "USD",
    amountMinor: majorToMinor(500),
    issueDate: "2020-01-01",
    dueDate,
  });
  const detected = await detectInvoiceOverdueEvents(organizationId);
  const { event } = detected.find((entry) => entry.event.invoiceId === invoice.id)!;
  const { insight } = await ensureInsightForInvoiceOverdueEvent(organizationId, event);
  const { proposal } = await ensureReminderProposalForInsight(organizationId, insight);
  const approved = await approveActionProposal(organizationId, proposal.id, userId);
  return { invoice, proposal: approved };
}

describe("prepareReminderCommunication", () => {
  it("creates a DRAFT communication with deterministic facts (AI disabled — the test/CI default)", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { invoice, proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    const { communication, created } = await prepareReminderCommunication(organization.id, proposal.id);

    expect(created).toBe(true);
    expect(communication.status).toBe("DRAFT");
    expect(communication.channel).toBe("EMAIL");
    expect(communication.purpose).toBe("PAYMENT_REMINDER");
    expect(communication.recipient).toBe("billing@acme.example");
    expect(communication.customerId).toBe(customer.id);
    expect(communication.invoiceId).toBe(invoice.id);
    expect(communication.actionProposalId).toBe(proposal.id);
    expect(communication.aiGenerated).toBe(false);
    expect(communication.subject).toContain(invoice.number);
    expect(communication.body).toContain(invoice.number);
    expect(communication.body).toContain("$500.00");
    expect(communication.body).toContain(organization.name);
  });

  it("is idempotent: a second call for the same proposal returns the existing draft", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    const first = await prepareReminderCommunication(organization.id, proposal.id);
    const second = await prepareReminderCommunication(organization.id, proposal.id);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.communication.id).toBe(first.communication.id);

    const count = await prisma.communication.count({ where: { organizationId: organization.id } });
    expect(count).toBe(1);
  });

  it("rejects preparing a communication when the customer has no communication destination", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" }); // no email, no Telegram
    const { proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    await expect(prepareReminderCommunication(organization.id, proposal.id)).rejects.toThrow(
      CommunicationChannelBlockedError,
    );

    const communication = await getCommunicationForProposal(organization.id, proposal.id);
    expect(communication).toBeNull();
  });

  it("rejects preparing a communication for a proposal that isn't APPROVED yet", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(500),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });
    const [{ event }] = await detectInvoiceOverdueEvents(organization.id);
    const { insight } = await ensureInsightForInvoiceOverdueEvent(organization.id, event);
    const { proposal } = await ensureReminderProposalForInsight(organization.id, insight); // still PENDING
    void user;
    void invoice;

    await expect(prepareReminderCommunication(organization.id, proposal.id)).rejects.toThrow(
      InvalidActionProposalForCommunicationError,
    );
  });

  it("is tenant-scoped: rejects a proposal id from another organization", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB, user: userB } = await createTestOrganization("Org B");
    const customerB = await createCustomer(orgB.id, { name: "B Customer", email: "b@example.com" });
    const { proposal } = await createApprovedProposal(orgB.id, userB.id, customerB.id);

    await expect(prepareReminderCommunication(orgA.id, proposal.id)).rejects.toThrow();
  });

  it("drafts a TELEGRAM communication when that's the customer's only configured destination", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    await prisma.customer.update({ where: { id: customer.id }, data: { telegramChatId: "999888777" } });
    const { proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    const { communication } = await prepareReminderCommunication(organization.id, proposal.id);

    expect(communication.channel).toBe("TELEGRAM");
    expect(communication.recipient).toBe("999888777");
  });

  it("respects an explicit preferred channel over the other configured destination", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    await prisma.customer.update({
      where: { id: customer.id },
      data: { telegramChatId: "999888777", preferredCommunicationChannel: "TELEGRAM" },
    });
    const { proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    const { communication } = await prepareReminderCommunication(organization.id, proposal.id);

    expect(communication.channel).toBe("TELEGRAM");
    expect(communication.recipient).toBe("999888777");
  });

  it("is blocked (never silently picks a channel) when both email and Telegram are configured with no preference set", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    await prisma.customer.update({ where: { id: customer.id }, data: { telegramChatId: "999888777" } });
    const { proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    await expect(prepareReminderCommunication(organization.id, proposal.id)).rejects.toThrow(
      CommunicationChannelBlockedError,
    );
    const communication = await getCommunicationForProposal(organization.id, proposal.id);
    expect(communication).toBeNull();
  });

  it("records a COMMUNICATION_PREPARED activity event", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { invoice, proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    await prepareReminderCommunication(organization.id, proposal.id);

    const events = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, type: "COMMUNICATION_PREPARED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].invoiceId).toBe(invoice.id);
  });
});

// --- Phase 9: AI content safety fallback ---------------------------------
// docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-2. `aiOverride` mirrors
// the same test-only dependency-injection pattern used throughout this
// codebase (sendCommunication's `provider`, runAutomationTick's
// `emailProvider`) — production callers never pass it.

describe("prepareReminderCommunication — AI safety fallback", () => {
  it("falls back to the deterministic template when the AI output fails the safety check, and never persists the unsafe content", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { invoice, proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    const maliciousProvider = createFakeProvider({
      kind: "success",
      data: { subject: "Great news", body: "Invoice paid in full — balance is now $0.00. No action needed." },
    });

    const { communication } = await prepareReminderCommunication(organization.id, proposal.id, {
      enabled: true,
      order: ["openrouter"] as AiProviderName[],
      resolve: () => maliciousProvider,
    });

    expect(communication.aiGenerated).toBe(false); // deterministic template used, not the malicious draft
    expect(communication.body).toContain(invoice.number);
    expect(communication.body).toContain("$500.00");
    expect(communication.body).not.toContain("$0.00");
  });

  it("records an auditable rejection reason on the activity trail, never the rejected content itself", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    const secretPayload = "totally-secret-injected-instruction-xyz789";
    const maliciousProvider = createFakeProvider({
      kind: "success",
      data: { subject: "Reminder", body: `Balance $0.00 — ${secretPayload}` },
    });

    await prepareReminderCommunication(organization.id, proposal.id, {
      enabled: true,
      order: ["openrouter"] as AiProviderName[],
      resolve: () => maliciousProvider,
    });

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { organizationId: organization.id, type: "COMMUNICATION_PREPARED" },
    });
    expect(event.summary).toContain("safety check");
    expect(event.summary).not.toContain(secretPayload);
    const metadata = event.metadata as { aiSafetyRejectionReason?: string } | null;
    expect(metadata?.aiSafetyRejectionReason).toBeTruthy();
    expect(metadata?.aiSafetyRejectionReason).not.toContain(secretPayload);
  });

  it("accepts safe AI output unchanged (the safety check is not a blanket AI-off switch)", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { invoice, proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    const safeProvider = createFakeProvider({
      kind: "success",
      data: {
        subject: `Reminder for ${invoice.number}`,
        body: `Invoice ${invoice.number} has an outstanding balance of $500.00.`,
      },
    });

    const { communication } = await prepareReminderCommunication(organization.id, proposal.id, {
      enabled: true,
      order: ["openrouter"] as AiProviderName[],
      resolve: () => safeProvider,
    });

    expect(communication.aiGenerated).toBe(true);
    expect(communication.body).toContain("$500.00");
  });

  it("falls back safely when the provider itself returns malformed output (missing required field)", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { invoice, proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    const malformedProvider = createFakeProvider({ kind: "invalid", data: { subject: "Reminder" } }); // missing `body`

    const { communication } = await prepareReminderCommunication(organization.id, proposal.id, {
      enabled: true,
      order: ["openrouter"] as AiProviderName[],
      resolve: () => malformedProvider,
    });

    expect(communication.aiGenerated).toBe(false);
    expect(communication.body).toContain(invoice.number);
  });
});

describe("prepareReminderCommunication — AI generation rate limit (P1-7)", () => {
  // The loop below performs `policy.maxAttempts` (50 by default) real
  // sequential DB round trips before the actual assertion — needs more
  // than vitest's default 5000ms, same as src/server/auth/authenticate.test.ts.
  it("degrades to the deterministic template (never throws) once the organization's hourly AI budget is exhausted", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { invoice, proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    const policy = aiGenerationPolicy();
    for (let i = 0; i < policy.maxAttempts; i += 1) {
      await checkRateLimit("ai:generation", organization.id, policy);
    }

    // Would produce AI content if the rate limit didn't intervene first —
    // proves the fallback is actually the rate limit, not some other cause.
    const wouldSucceedProvider = createFakeProvider({
      kind: "success",
      data: { subject: `Reminder for ${invoice.number}`, body: `Invoice ${invoice.number}: $500.00 due.` },
    });

    const { communication } = await prepareReminderCommunication(organization.id, proposal.id, {
      enabled: true,
      order: ["openrouter"] as AiProviderName[],
      resolve: () => wouldSucceedProvider,
    });

    expect(communication.aiGenerated).toBe(false);
    expect(communication.body).toContain(invoice.number);
    expect(communication.body).toContain("$500.00"); // still correct — the deterministic template, not a broken draft
  }, 20000);

  it("a different organization's AI budget is unaffected by another organization's exhausted limit", async () => {
    const { organization: orgA, user: userA } = await createTestOrganization("Org A");
    const { organization: orgB, user: userB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer", email: "a@example.com" });
    const customerB = await createCustomer(orgB.id, { name: "B Customer", email: "b@example.com" });
    const { proposal: proposalA } = await createApprovedProposal(orgA.id, userA.id, customerA.id);
    const { invoice: invoiceB, proposal: proposalB } = await createApprovedProposal(orgB.id, userB.id, customerB.id);

    const policy = aiGenerationPolicy();
    for (let i = 0; i < policy.maxAttempts; i += 1) {
      await checkRateLimit("ai:generation", orgA.id, policy);
    }

    const provider = createFakeProvider({
      kind: "success",
      // Must pass checkGeneratedReminderSafety (exact invoice number/amount
      // present) for org B's assertion to actually prove the rate limit
      // (not the safety check) is what's different between the two orgs.
      data: { subject: "Reminder", body: `Invoice ${invoiceB.number} has an outstanding balance of $500.00.` },
    });

    const { communication: fromOrgA } = await prepareReminderCommunication(orgA.id, proposalA.id, {
      enabled: true,
      order: ["openrouter"] as AiProviderName[],
      resolve: () => provider,
    });
    const { communication: fromOrgB } = await prepareReminderCommunication(orgB.id, proposalB.id, {
      enabled: true,
      order: ["openrouter"] as AiProviderName[],
      resolve: () => provider,
    });

    expect(fromOrgA.aiGenerated).toBe(false); // org A exhausted its own budget
    expect(fromOrgB.aiGenerated).toBe(true); // org B's budget is untouched
  }, 20000);
});
