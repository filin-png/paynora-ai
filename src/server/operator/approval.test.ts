import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import {
  approveActionProposal,
  dismissActionProposal,
  listPendingActionProposals,
} from "./approval";
import { detectInvoiceOverdueEvents } from "./events";
import { InvalidActionProposalTransitionError, OperatorResourceNotFoundError } from "./errors";
import { ensureInsightForInvoiceOverdueEvent } from "./insights";
import { ensureReminderProposalForInsight } from "./proposals";

beforeEach(async () => {
  await resetDatabase();
});

async function createPendingProposal(organizationId: string, customerId: string, dueDate = "2020-01-15") {
  const invoice = await createInvoice(organizationId, {
    customerId,
    number: `INV-${Math.random().toString(36).slice(2, 8)}`,
    currency: "USD",
    amountMinor: majorToMinor(250),
    issueDate: "2020-01-01",
    dueDate,
  });
  // detectInvoiceOverdueEvents returns one entry per *currently* overdue
  // invoice for the org, not just this one — a prior invoice created in
  // the same test may still be overdue too. Pick the event for the
  // invoice this call just created rather than assuming array position.
  const detected = await detectInvoiceOverdueEvents(organizationId);
  const { event } = detected.find((entry) => entry.event.invoiceId === invoice.id)!;
  const { insight } = await ensureInsightForInvoiceOverdueEvent(organizationId, event);
  const { proposal } = await ensureReminderProposalForInsight(organizationId, insight);
  return { invoice, proposal };
}

describe("approveActionProposal", () => {
  it("moves a PENDING proposal to APPROVED and records who/when", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { proposal } = await createPendingProposal(organization.id, customer.id);

    const approved = await approveActionProposal(organization.id, proposal.id, user.id);

    expect(approved.status).toBe("APPROVED");
    expect(approved.decidedByUserId).toBe(user.id);
    expect(approved.decidedAt).not.toBeNull();
  });

  it("is idempotent: approving an already-approved proposal is a no-op, not an error", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { proposal } = await createPendingProposal(organization.id, customer.id);

    const first = await approveActionProposal(organization.id, proposal.id, user.id);
    const second = await approveActionProposal(organization.id, proposal.id, user.id);

    expect(second.status).toBe("APPROVED");
    expect(second.decidedAt).toEqual(first.decidedAt);
  });

  it("rejects approving a DISMISSED proposal (no silent DISMISSED -> APPROVED)", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { proposal } = await createPendingProposal(organization.id, customer.id);

    await dismissActionProposal(organization.id, proposal.id, user.id);

    await expect(approveActionProposal(organization.id, proposal.id, user.id)).rejects.toThrow(
      InvalidActionProposalTransitionError,
    );
  });

  it("never actually sends anything — approving only changes status", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { proposal } = await createPendingProposal(organization.id, customer.id);

    const approved = await approveActionProposal(organization.id, proposal.id, user.id);

    expect(approved.status).not.toBe("EXECUTED");
    expect(approved.status).toBe("APPROVED");
  });

  it("is tenant-scoped: an org cannot approve another org's proposal", async () => {
    const { organization: orgA, user: userA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    const { proposal } = await createPendingProposal(orgA.id, customerA.id);

    await expect(approveActionProposal(orgB.id, proposal.id, userA.id)).rejects.toThrow(
      OperatorResourceNotFoundError,
    );
  });

  it("records an audited activity event on approval", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { invoice, proposal } = await createPendingProposal(organization.id, customer.id);

    await approveActionProposal(organization.id, proposal.id, user.id);

    const events = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, type: "ACTION_PROPOSAL_APPROVED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].invoiceId).toBe(invoice.id);
  });
});

describe("dismissActionProposal", () => {
  it("moves a PENDING proposal to DISMISSED", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { proposal } = await createPendingProposal(organization.id, customer.id);

    const dismissed = await dismissActionProposal(organization.id, proposal.id, user.id);
    expect(dismissed.status).toBe("DISMISSED");
  });

  it("rejects dismissing an APPROVED proposal", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { proposal } = await createPendingProposal(organization.id, customer.id);

    await approveActionProposal(organization.id, proposal.id, user.id);

    await expect(dismissActionProposal(organization.id, proposal.id, user.id)).rejects.toThrow(
      InvalidActionProposalTransitionError,
    );
  });

  it("is idempotent: dismissing an already-dismissed proposal is a no-op", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { proposal } = await createPendingProposal(organization.id, customer.id);

    await dismissActionProposal(organization.id, proposal.id, user.id);
    const second = await dismissActionProposal(organization.id, proposal.id, user.id);
    expect(second.status).toBe("DISMISSED");
  });
});

describe("listPendingActionProposals", () => {
  it("returns only PENDING proposals for the calling organization, highest priority first", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });

    const { proposal: low } = await createPendingProposal(organization.id, customer.id, "2026-08-05"); // recent, LOW
    const { proposal: high } = await createPendingProposal(organization.id, customer.id, "2020-01-15"); // HIGH
    await dismissActionProposal(organization.id, low.id, user.id);
    const { proposal: medium } = await createPendingProposal(organization.id, customer.id, "2026-07-25"); // ~MEDIUM

    const pending = await listPendingActionProposals(organization.id);

    expect(pending.map((p) => p.id)).not.toContain(low.id);
    expect(pending[0].id).toBe(high.id);
    expect(pending.some((p) => p.id === medium.id)).toBe(true);
  });
});
