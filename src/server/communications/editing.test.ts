import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

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
import { prepareReminderCommunication } from "./draft";
import { updateCommunicationDraft } from "./editing";
import { InvalidCommunicationTransitionError } from "./errors";
import { MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH } from "./templates";

beforeEach(async () => {
  await resetDatabase();
});

async function createDraftCommunication(organizationId: string, userId: string, customerId: string) {
  const invoice = await createInvoice(organizationId, {
    customerId,
    number: `INV-${Math.random().toString(36).slice(2, 8)}`,
    currency: "USD",
    amountMinor: majorToMinor(500),
    issueDate: "2020-01-01",
    dueDate: "2020-01-15",
  });
  const detected = await detectInvoiceOverdueEvents(organizationId);
  const { event } = detected.find((entry) => entry.event.invoiceId === invoice.id)!;
  const { insight } = await ensureInsightForInvoiceOverdueEvent(organizationId, event);
  const { proposal } = await ensureReminderProposalForInsight(organizationId, insight);
  await approveActionProposal(organizationId, proposal.id, userId);
  const { communication } = await prepareReminderCommunication(organizationId, proposal.id);
  return { invoice, communication };
}

describe("updateCommunicationDraft", () => {
  it("updates subject and body while still DRAFT", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { communication } = await createDraftCommunication(organization.id, user.id, customer.id);

    const updated = await updateCommunicationDraft(organization.id, communication.id, {
      subject: "A friendlier subject",
      body: "A friendlier body.",
    });

    expect(updated.subject).toBe("A friendlier subject");
    expect(updated.body).toBe("A friendlier body.");
    expect(updated.status).toBe("DRAFT");
  });

  it("rejects an empty subject", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { communication } = await createDraftCommunication(organization.id, user.id, customer.id);

    await expect(
      updateCommunicationDraft(organization.id, communication.id, { subject: "   ", body: "Body" }),
    ).rejects.toThrow(z.ZodError);
  });

  it("rejects an oversized subject/body", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { communication } = await createDraftCommunication(organization.id, user.id, customer.id);

    await expect(
      updateCommunicationDraft(organization.id, communication.id, {
        subject: "a".repeat(MAX_SUBJECT_LENGTH + 1),
        body: "Body",
      }),
    ).rejects.toThrow(z.ZodError);

    await expect(
      updateCommunicationDraft(organization.id, communication.id, {
        subject: "Subject",
        body: "a".repeat(MAX_BODY_LENGTH + 1),
      }),
    ).rejects.toThrow(z.ZodError);
  });

  it("rejects a subject containing a CR or LF (header injection)", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { communication } = await createDraftCommunication(organization.id, user.id, customer.id);

    await expect(
      updateCommunicationDraft(organization.id, communication.id, {
        subject: "Reminder\r\nBcc: attacker@evil.example",
        body: "Body",
      }),
    ).rejects.toThrow(z.ZodError);
  });

  it("is tenant-scoped: rejects editing another organization's communication", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB, user: userB } = await createTestOrganization("Org B");
    const customerB = await createCustomer(orgB.id, { name: "B Customer", email: "b@example.com" });
    const { communication } = await createDraftCommunication(orgB.id, userB.id, customerB.id);

    await expect(
      updateCommunicationDraft(orgA.id, communication.id, { subject: "hi", body: "hi" }),
    ).rejects.toThrow();

    const reloaded = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloaded.subject).toBe(communication.subject);
  });

  it("rejects editing once the communication has left DRAFT", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
    const { communication } = await createDraftCommunication(organization.id, user.id, customer.id);

    await prisma.communication.update({ where: { id: communication.id }, data: { status: "SENDING" } });

    await expect(
      updateCommunicationDraft(organization.id, communication.id, { subject: "hi", body: "hi" }),
    ).rejects.toThrow(InvalidCommunicationTransitionError);
  });
});
