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
import { getCommunicationForProposal, prepareReminderCommunication } from "./draft";
import { InvalidActionProposalForCommunicationError, MissingCustomerEmailError } from "./errors";

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

  it("rejects preparing a communication when the customer has no email", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" }); // no email
    const { proposal } = await createApprovedProposal(organization.id, user.id, customer.id);

    await expect(prepareReminderCommunication(organization.id, proposal.id)).rejects.toThrow(
      MissingCustomerEmailError,
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
