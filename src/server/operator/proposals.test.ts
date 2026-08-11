import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { detectInvoiceOverdueEvents } from "./events";
import { ensureInsightForInvoiceOverdueEvent } from "./insights";
import { ensureReminderProposalForInsight } from "./proposals";

beforeEach(async () => {
  await resetDatabase();
});

async function createInsight(organizationId: string, customerId: string, dueDate: string) {
  const invoice = await createInvoice(organizationId, {
    customerId,
    number: `INV-${Math.random().toString(36).slice(2, 8)}`,
    currency: "USD",
    amountMinor: majorToMinor(250),
    issueDate: "2020-01-01",
    dueDate,
  });
  const [{ event }] = await detectInvoiceOverdueEvents(organizationId);
  const { insight } = await ensureInsightForInvoiceOverdueEvent(organizationId, event);
  return { invoice, event, insight };
}

describe("ensureReminderProposalForInsight", () => {
  it("creates a PENDING SEND_PAYMENT_REMINDER proposal for an insight", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { invoice, insight } = await createInsight(organization.id, customer.id, "2020-01-15");

    const { proposal, created } = await ensureReminderProposalForInsight(organization.id, insight);

    expect(created).toBe(true);
    expect(proposal.type).toBe("SEND_PAYMENT_REMINDER");
    expect(proposal.status).toBe("PENDING");
    expect(proposal.insightId).toBe(insight.id);
    expect(proposal.invoiceId).toBe(invoice.id);
    expect(proposal.customerId).toBe(customer.id);
    expect(proposal.reasoning).toBe(insight.summary);
    expect(proposal.suggestedTone).toBe("firm"); // HIGH priority -> firm
    expect(proposal.decidedAt).toBeNull();
    expect(proposal.decidedByUserId).toBeNull();
  });

  it("is idempotent: a second call for the same insight returns the existing proposal", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { insight } = await createInsight(organization.id, customer.id, "2020-01-15");

    const first = await ensureReminderProposalForInsight(organization.id, insight);
    const second = await ensureReminderProposalForInsight(organization.id, insight);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.proposal.id).toBe(first.proposal.id);

    const count = await prisma.actionProposal.count({ where: { organizationId: organization.id } });
    expect(count).toBe(1);
  });

  it("only ever proposes an allowlisted action type", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { insight } = await createInsight(organization.id, customer.id, "2020-01-15");

    const { proposal } = await ensureReminderProposalForInsight(organization.id, insight);
    expect(["SEND_PAYMENT_REMINDER"]).toContain(proposal.type);
  });
});
