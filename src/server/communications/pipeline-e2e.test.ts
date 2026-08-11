import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { createFakeEmailProvider } from "@/server/email/providers/fake";
import { approveActionProposal, listPendingActionProposals } from "@/server/operator/approval";
import { runOperator } from "@/server/operator/pipeline";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { prepareReminderCommunication } from "./draft";
import { sendCommunication } from "./send";

beforeEach(async () => {
  await resetDatabase();
});

describe("end-to-end: overdue invoice -> Operator -> approve -> draft -> send -> SENT -> proposal EXECUTED", () => {
  it("completes the full Phase 3 + Phase 4 pipeline with a deterministic fake provider and zero real network calls", async () => {
    const { organization, user } = await createTestOrganization();
    const customer = await createCustomer(organization.id, {
      name: "Acme Co",
      email: "billing@acme.example",
    });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-E2E-1",
      currency: "USD",
      amountMinor: majorToMinor(750),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });

    // 1. Operator detects the overdue invoice and proposes a reminder.
    const runSummary = await runOperator(organization.id);
    expect(runSummary.eventsNew).toBe(1);
    expect(runSummary.proposalsCreated).toBe(1);

    const pending = await listPendingActionProposals(organization.id);
    expect(pending).toHaveLength(1);
    const proposal = pending[0];
    expect(proposal.type).toBe("SEND_PAYMENT_REMINDER");
    expect(proposal.invoiceId).toBe(invoice.id);

    // 2. A human approves it. Approval alone must not send anything.
    const approved = await approveActionProposal(organization.id, proposal.id, user.id);
    expect(approved.status).toBe("APPROVED");

    // 3. A draft is prepared with deterministic facts (AI disabled by default).
    const { communication, created } = await prepareReminderCommunication(organization.id, approved.id);
    expect(created).toBe(true);
    expect(communication.status).toBe("DRAFT");
    expect(communication.recipient).toBe("billing@acme.example");
    expect(communication.body).toContain("INV-E2E-1");
    expect(communication.body).toContain("$750.00");

    // 4. Explicit send, via a deterministic fake provider — no real network call.
    const provider = createFakeEmailProvider({ kind: "success", providerMessageId: "e2e-msg-1" });
    const result = await sendCommunication(organization.id, communication.id, user.id, { provider });

    expect(result.communication.status).toBe("SENT");
    expect(result.deliveryAttempt.status).toBe("SUCCESS");
    expect(result.deliveryAttempt.providerMessageId).toBe("e2e-msg-1");
    expect(result.actionProposal?.status).toBe("EXECUTED");

    // 5. Final state is fully consistent when re-read from the database.
    const finalProposal = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(finalProposal.status).toBe("EXECUTED");

    const finalCommunication = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(finalCommunication.status).toBe("SENT");
    expect(finalCommunication.sentAt).not.toBeNull();

    const activity = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, invoiceId: invoice.id },
      orderBy: { createdAt: "asc" },
    });
    const activityTypes = activity.map((event) => event.type);
    expect(activityTypes).toContain("ACTION_PROPOSAL_APPROVED");
    expect(activityTypes).toContain("COMMUNICATION_PREPARED");
    expect(activityTypes).toContain("COMMUNICATION_SEND_ATTEMPTED");
    expect(activityTypes).toContain("COMMUNICATION_SENT");
    expect(activityTypes).toContain("ACTION_PROPOSAL_EXECUTED");

    // Re-running the Operator afterward must not create a duplicate proposal/communication.
    const secondRun = await runOperator(organization.id);
    expect(secondRun.proposalsCreated).toBe(0);
    const proposalCount = await prisma.actionProposal.count({ where: { organizationId: organization.id } });
    expect(proposalCount).toBe(1);
  });
});
