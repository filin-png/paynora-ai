import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { cancelInvoice, createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { recordPayment } from "@/server/ar/payments";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { detectInvoiceOverdueEvents } from "./events";
import { ensureInsightForInvoiceOverdueEvent } from "./insights";
import { ensureReminderProposalForInsight } from "./proposals";
import { markStaleActionProposals } from "./stale";

beforeEach(async () => {
  await resetDatabase();
});

async function createPendingReminderProposal(organizationId: string, customerId: string, dueDate: string) {
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
  const { proposal } = await ensureReminderProposalForInsight(organizationId, insight);
  return { invoice, proposal };
}

describe("markStaleActionProposals", () => {
  it("marks a PENDING proposal stale once its invoice is fully paid", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const { invoice, proposal } = await createPendingReminderProposal(organization.id, customer.id, "2020-01-15");

    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(250), paidAt: "2024-01-01" });
    const { markedStale } = await markStaleActionProposals(organization.id);

    expect(markedStale).toBe(1);
    const reloaded = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(reloaded.status).toBe("STALE");
  });

  it("marks a PENDING proposal stale once its invoice is cancelled", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const { invoice, proposal } = await createPendingReminderProposal(organization.id, customer.id, "2020-01-15");

    await cancelInvoice(organization.id, invoice.id);
    const { markedStale } = await markStaleActionProposals(organization.id);

    expect(markedStale).toBe(1);
    const reloaded = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(reloaded.status).toBe("STALE");
  });

  it("records an audit ActivityEvent when marking a proposal stale", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const { invoice } = await createPendingReminderProposal(organization.id, customer.id, "2020-01-15");
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(250), paidAt: "2024-01-01" });

    await markStaleActionProposals(organization.id);

    const activity = await prisma.activityEvent.findFirst({
      where: { organizationId: organization.id, type: "ACTION_PROPOSAL_MARKED_STALE" },
    });
    expect(activity).not.toBeNull();
    expect(activity?.invoiceId).toBe(invoice.id);
  });

  it("does not touch a proposal that is still genuinely overdue and unpaid", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const { proposal } = await createPendingReminderProposal(organization.id, customer.id, "2020-01-15");

    const { markedStale } = await markStaleActionProposals(organization.id);

    expect(markedStale).toBe(0);
    const reloaded = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(reloaded.status).toBe("PENDING");
  });

  it("never overwrites a proposal a human has already decided", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const { invoice, proposal } = await createPendingReminderProposal(organization.id, customer.id, "2020-01-15");

    await prisma.actionProposal.update({
      where: { id: proposal.id },
      data: { status: "APPROVED", decidedAt: new Date(), decidedByUserId: user.id },
    });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(250), paidAt: "2024-01-01" });

    const { markedStale } = await markStaleActionProposals(organization.id);

    expect(markedStale).toBe(0);
    const reloaded = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(reloaded.status).toBe("APPROVED");
  });

  it("only marks stale proposals for the calling organization (tenant isolation)", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    const { invoice, proposal } = await createPendingReminderProposal(orgA.id, customerA.id, "2020-01-15");
    await recordPayment(orgA.id, invoice.id, { amountMinor: majorToMinor(250), paidAt: "2024-01-01" });

    const { markedStale } = await markStaleActionProposals(orgB.id);

    expect(markedStale).toBe(0);
    const reloaded = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(reloaded.status).toBe("PENDING");
  });
});
