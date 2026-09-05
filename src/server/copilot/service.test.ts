import { beforeEach, describe, expect, it } from "vitest";

import { ArResourceNotFoundError } from "@/server/ar/errors";
import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { recordPayment } from "@/server/ar/payments";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { FeatureNotEntitledError } from "@/server/billing/entitlements";
import { setOrganizationPlan } from "@/server/billing/subscription";
import { resetDatabase } from "@/server/db/test-utils";
import { detectInvoiceOverdueEvents } from "@/server/operator/events";
import { OperatorResourceNotFoundError } from "@/server/operator/errors";
import { ensureInsightForInvoiceOverdueEvent } from "@/server/operator/insights";
import { ensureReminderProposalForInsight } from "@/server/operator/proposals";
import { answerCopilotQuestion } from "./service";

beforeEach(async () => {
  await resetDatabase();
});

/**
 * Phase 19: Copilot requires a plan with `copilotEnabled` (STARTER+) —
 * every test below exercises Copilot's own deterministic/tenant-isolation
 * logic, not the entitlement gate itself (that has its own dedicated test
 * further down, plus src/server/billing/entitlements.test.ts), so each
 * fixture is upgraded past FREE here rather than repeating the gate check
 * in every scenario.
 */
async function createCopilotEntitledOrganization(namePrefix?: string) {
  const result = await createTestOrganization(namePrefix);
  await setOrganizationPlan(result.organization.id, "STARTER");
  return result;
}

async function createPendingReminderProposal(organizationId: string, customerId: string) {
  const invoice = await createInvoice(organizationId, {
    customerId,
    number: "INV-1",
    currency: "USD",
    amountMinor: majorToMinor(250),
    issueDate: "2020-01-01",
    dueDate: "2020-01-15",
  });
  const [{ event }] = await detectInvoiceOverdueEvents(organizationId);
  const { insight } = await ensureInsightForInvoiceOverdueEvent(organizationId, event);
  const { proposal } = await ensureReminderProposalForInsight(organizationId, insight);
  return { invoice, proposal };
}

describe("answerCopilotQuestion", () => {
  it("why_important: returns the proposal's own deterministic reasoning, with AI disabled (the test/CI default)", async () => {
    const { organization } = await createCopilotEntitledOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const { proposal } = await createPendingReminderProposal(organization.id, customer.id);

    const answer = await answerCopilotQuestion(organization.id, "why_important", proposal.id);

    expect(answer.aiGenerated).toBe(false);
    expect(answer.aiAnswer).toBeUndefined();
    expect(answer.deterministicAnswer).toContain(proposal.reasoning);
    expect(answer.deterministicAnswer.length).toBeGreaterThan(0);
  });

  it("why_important: throws for a proposal id from another organization (tenant isolation)", async () => {
    const { organization: orgA } = await createCopilotEntitledOrganization("Org A");
    const { organization: orgB } = await createCopilotEntitledOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    const { proposal } = await createPendingReminderProposal(orgA.id, customerA.id);

    await expect(answerCopilotQuestion(orgB.id, "why_important", proposal.id)).rejects.toThrow(
      OperatorResourceNotFoundError,
    );
  });

  it("explain_customer: summarizes outstanding balance and payment trend from real data", async () => {
    const { organization } = await createCopilotEntitledOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(500),
      issueDate: "2020-01-01",
      dueDate: "2099-01-15",
    });

    const answer = await answerCopilotQuestion(organization.id, "explain_customer", customer.id);

    expect(answer.deterministicAnswer).toContain("Acme Co");
    expect(answer.deterministicAnswer).toContain("Not enough payment history");
  });

  it("explain_customer: throws for a customer id from another organization (tenant isolation)", async () => {
    const { organization: orgA } = await createCopilotEntitledOrganization("Org A");
    const { organization: orgB } = await createCopilotEntitledOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });

    await expect(answerCopilotQuestion(orgB.id, "explain_customer", customerA.id)).rejects.toThrow(
      ArResourceNotFoundError,
    );
  });

  it("what_changed_this_week: reports real recent payments, never fabricated ones", async () => {
    const { organization } = await createCopilotEntitledOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(300),
      issueDate: "2020-01-01",
      dueDate: "2099-01-15",
    });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(300), paidAt: "2020-01-05" });

    const answer = await answerCopilotQuestion(organization.id, "what_changed_this_week");
    expect(answer.deterministicAnswer).toContain("received");
  });

  it("what_changed_this_week: says nothing changed rather than fabricating an event", async () => {
    const { organization } = await createCopilotEntitledOrganization();
    const answer = await answerCopilotQuestion(organization.id, "what_changed_this_week");
    expect(answer.deterministicAnswer).toContain("Nothing notable changed");
  });

  it("focus_invoices: lists real overdue invoices with their attention score", async () => {
    const { organization } = await createCopilotEntitledOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-FOCUS-1",
      currency: "USD",
      amountMinor: majorToMinor(500),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });

    const answer = await answerCopilotQuestion(organization.id, "focus_invoices");
    expect(answer.deterministicAnswer).toContain("INV-FOCUS-1");
    expect(answer.deterministicAnswer).toContain("attention score");
  });

  it("focus_invoices: says nothing needs attention rather than inventing a risky invoice", async () => {
    const { organization } = await createCopilotEntitledOrganization();
    const answer = await answerCopilotQuestion(organization.id, "focus_invoices");
    expect(answer.deterministicAnswer).toContain("No invoices need attention");
  });

  it("cash_flow_risk: reports no data rather than a fabricated risk window when there are no invoices", async () => {
    const { organization } = await createCopilotEntitledOrganization();
    const answer = await answerCopilotQuestion(organization.id, "cash_flow_risk");
    expect(answer.deterministicAnswer).toContain("isn't enough open-invoice data");
  });

  it("Phase 19: throws FeatureNotEntitledError on the default FREE plan, before touching any deterministic builder", async () => {
    const { organization } = await createTestOrganization();

    await expect(answerCopilotQuestion(organization.id, "cash_flow_risk")).rejects.toThrow(FeatureNotEntitledError);
  });
});
