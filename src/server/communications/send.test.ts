import { beforeEach, describe, expect, it } from "vitest";

import { approveActionProposal } from "@/server/operator/approval";
import { detectInvoiceOverdueEvents } from "@/server/operator/events";
import { ensureInsightForInvoiceOverdueEvent } from "@/server/operator/insights";
import { ensureReminderProposalForInsight } from "@/server/operator/proposals";
import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { EmailDisabledError } from "@/server/email/errors";
import { createFakeEmailProvider } from "@/server/email/providers/fake";
import type { EmailMessage, EmailProvider } from "@/server/email/types";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { prepareReminderCommunication } from "./draft";
import { updateCommunicationDraft } from "./editing";
import { InvalidCommunicationTransitionError } from "./errors";
import { sendCommunication } from "./send";

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
  const approved = await approveActionProposal(organizationId, proposal.id, userId);
  const { communication } = await prepareReminderCommunication(organizationId, approved.id);
  return { invoice, proposal: approved, communication };
}

async function setup() {
  const { organization, user } = await createTestOrganization();
  const customer = await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });
  const { invoice, proposal, communication } = await createDraftCommunication(organization.id, user.id, customer.id);
  return { organization, user, customer, invoice, proposal, communication };
}

describe("sendCommunication — success", () => {
  it("sends, marks SENT, records a SUCCESS DeliveryAttempt, and executes the proposal", async () => {
    const { organization, user, proposal, communication } = await setup();
    const provider = createFakeEmailProvider({ kind: "success", providerMessageId: "provider-msg-1" });

    const result = await sendCommunication(organization.id, communication.id, user.id, { provider });

    expect(result.communication.status).toBe("SENT");
    expect(result.communication.sentAt).not.toBeNull();
    expect(result.deliveryAttempt.status).toBe("SUCCESS");
    expect(result.deliveryAttempt.providerMessageId).toBe("provider-msg-1");
    expect(result.deliveryAttempt.attemptNumber).toBe(1);
    expect(result.actionProposal?.status).toBe("EXECUTED");

    const reloadedProposal = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(reloadedProposal.status).toBe("EXECUTED");
    // Approval provenance must survive execution — only status changes.
    expect(reloadedProposal.decidedByUserId).toBe(user.id);
  });

  it("passes the communication's exact recipient/subject/body to the provider", async () => {
    const { organization, user, communication } = await setup();
    let received: EmailMessage | null = null;
    const provider: EmailProvider = {
      name: "spy",
      async send(message) {
        received = message;
        return { provider: "spy" };
      },
    };

    await sendCommunication(organization.id, communication.id, user.id, { provider });

    expect(received).not.toBeNull();
    expect(received!.to).toBe(communication.recipient);
    expect(received!.subject).toBe(communication.subject);
    expect(received!.text).toBe(communication.body);
  });
});

describe("sendCommunication — definite rejection", () => {
  it("marks FAILED and does not execute the proposal", async () => {
    const { organization, user, proposal, communication } = await setup();
    const provider = createFakeEmailProvider({ kind: "rejected", message: "no such mailbox" });

    const result = await sendCommunication(organization.id, communication.id, user.id, { provider });

    expect(result.communication.status).toBe("FAILED");
    expect(result.deliveryAttempt.status).toBe("FAILED");
    expect(result.deliveryAttempt.failureCategory).toBe("PROVIDER_REJECTED");
    expect(result.actionProposal).toBeNull();

    const reloadedProposal = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(reloadedProposal.status).toBe("APPROVED");
  });

  it("allows a retry after FAILED, recording a new DeliveryAttempt without losing the first", async () => {
    const { organization, user, communication } = await setup();
    const rejecting = createFakeEmailProvider({ kind: "rejected", message: "no such mailbox" });
    await sendCommunication(organization.id, communication.id, user.id, { provider: rejecting });

    const succeeding = createFakeEmailProvider({ kind: "success" });
    const retryResult = await sendCommunication(organization.id, communication.id, user.id, {
      provider: succeeding,
    });

    expect(retryResult.communication.status).toBe("SENT");
    expect(retryResult.deliveryAttempt.attemptNumber).toBe(2);

    const attempts = await prisma.deliveryAttempt.findMany({
      where: { communicationId: communication.id },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe("FAILED");
    expect(attempts[1].status).toBe("SUCCESS");
  });
});

describe("sendCommunication — unknown/uncertain outcome", () => {
  it("marks UNCERTAIN (never FAILED, never SENT) on an unrecognized provider error", async () => {
    const { organization, user, proposal, communication } = await setup();
    const provider = createFakeEmailProvider({ kind: "error", message: "ECONNRESET" });

    const result = await sendCommunication(organization.id, communication.id, user.id, { provider });

    expect(result.communication.status).toBe("UNCERTAIN");
    expect(result.deliveryAttempt.status).toBe("UNKNOWN");
    expect(result.actionProposal).toBeNull();

    const reloadedProposal = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(reloadedProposal.status).toBe("APPROVED");
  });

  it("blocks a second send attempt while the first is still in flight", async () => {
    // The gateway's own timeout mechanism (a dispatch that never resolves
    // eventually becomes EmailTimeoutError -> UNCERTAIN) is covered
    // directly and quickly in src/server/email/gateway.test.ts with a
    // short custom timeout; this test uses a manually-controlled provider
    // to verify the domain-level invariant that matters here — a send
    // already in flight blocks a second concurrent attempt — without
    // waiting out a real timeout.
    const { organization, user, communication } = await setup();
    let releaseFirstSend: (() => void) | null = null;
    const controlledProvider: EmailProvider = {
      name: "controlled",
      send: () =>
        new Promise((resolve) => {
          releaseFirstSend = () => resolve({ provider: "controlled" });
        }),
    };

    const firstSend = sendCommunication(organization.id, communication.id, user.id, {
      provider: controlledProvider,
    });
    // Let the claim transaction (DRAFT -> SENDING) commit before the
    // second attempt starts — the claim itself is a fast, already-awaited
    // DB round trip inside sendCommunication, ahead of the (still
    // pending) provider call.
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(
      sendCommunication(organization.id, communication.id, user.id, {
        provider: createFakeEmailProvider({ kind: "success" }),
      }),
    ).rejects.toThrow(InvalidCommunicationTransitionError);

    releaseFirstSend!();
    const result = await firstSend;
    expect(result.communication.status).toBe("SENT");
  });

  it("blocks resending an UNCERTAIN communication without explicit acknowledgement", async () => {
    const { organization, user, communication } = await setup();
    await sendCommunication(organization.id, communication.id, user.id, {
      provider: createFakeEmailProvider({ kind: "error", message: "network blip" }),
    });

    await expect(
      sendCommunication(organization.id, communication.id, user.id, {
        provider: createFakeEmailProvider({ kind: "success" }),
      }),
    ).rejects.toThrow(InvalidCommunicationTransitionError);

    const reloaded = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloaded.status).toBe("UNCERTAIN");
  });

  it("allows resending an UNCERTAIN communication with explicit acknowledgement", async () => {
    const { organization, user, communication } = await setup();
    await sendCommunication(organization.id, communication.id, user.id, {
      provider: createFakeEmailProvider({ kind: "error", message: "network blip" }),
    });

    const result = await sendCommunication(organization.id, communication.id, user.id, {
      provider: createFakeEmailProvider({ kind: "success" }),
      acknowledgeUncertainRisk: true,
    });

    expect(result.communication.status).toBe("SENT");
    expect(result.deliveryAttempt.attemptNumber).toBe(2);
  });
});

describe("sendCommunication — terminal/stuck state protection", () => {
  it("never re-sends an already-SENT communication, with or without acknowledgement", async () => {
    const { organization, user, communication } = await setup();
    await sendCommunication(organization.id, communication.id, user.id, {
      provider: createFakeEmailProvider({ kind: "success" }),
    });

    await expect(
      sendCommunication(organization.id, communication.id, user.id, {
        provider: createFakeEmailProvider({ kind: "success" }),
      }),
    ).rejects.toThrow(InvalidCommunicationTransitionError);
    await expect(
      sendCommunication(organization.id, communication.id, user.id, {
        provider: createFakeEmailProvider({ kind: "success" }),
        acknowledgeUncertainRisk: true,
      }),
    ).rejects.toThrow(InvalidCommunicationTransitionError);

    const attempts = await prisma.deliveryAttempt.count({ where: { communicationId: communication.id } });
    expect(attempts).toBe(1); // only the original successful attempt — no phantom second dispatch
  });

  it("a communication stuck in SENDING (e.g. the process crashed before recording an outcome) cannot be resent by any button, even with acknowledgement", async () => {
    // Simulates exactly the crash scenario docs/communications.md#unknown-outcomes
    // describes: the provider may or may not have accepted the email, but
    // the process died before finalizeSuccess/finalizeTerminal ever ran,
    // so the row is stuck at SENDING with no terminal DeliveryAttempt.
    const { organization, user, communication } = await setup();
    await prisma.communication.update({ where: { id: communication.id }, data: { status: "SENDING" } });

    await expect(
      sendCommunication(organization.id, communication.id, user.id, {
        provider: createFakeEmailProvider({ kind: "success" }),
      }),
    ).rejects.toThrow(InvalidCommunicationTransitionError);
    // The "Resend anyway" acknowledgement only ever unlocks UNCERTAIN, not
    // a bare SENDING — a stuck send is not safely distinguishable from one
    // that's genuinely still in flight, so it must never be treated as
    // equivalent to a confirmed-ambiguous UNCERTAIN outcome.
    await expect(
      sendCommunication(organization.id, communication.id, user.id, {
        provider: createFakeEmailProvider({ kind: "success" }),
        acknowledgeUncertainRisk: true,
      }),
    ).rejects.toThrow(InvalidCommunicationTransitionError);

    const reloaded = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloaded.status).toBe("SENDING");
    const attempts = await prisma.deliveryAttempt.count({ where: { communicationId: communication.id } });
    expect(attempts).toBe(0); // no DeliveryAttempt was ever created for the simulated crash, and none is created by the blocked resend attempts
  });
});

describe("sendCommunication — tenant isolation", () => {
  it("rejects sending another organization's communication", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB, user: userB } = await createTestOrganization("Org B");
    const customerB = await createCustomer(orgB.id, { name: "B Customer", email: "b@example.com" });
    const { communication } = await createDraftCommunication(orgB.id, userB.id, customerB.id);

    await expect(
      sendCommunication(orgA.id, communication.id, userB.id, {
        provider: createFakeEmailProvider({ kind: "success" }),
      }),
    ).rejects.toThrow();

    const reloaded = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloaded.status).toBe("DRAFT");
  });
});

describe("sendCommunication — missing provider configuration", () => {
  it("throws EmailDisabledError and makes no state changes (EMAIL_PROVIDER=none, the test/CI default)", async () => {
    const { organization, user, communication } = await setup();

    await expect(sendCommunication(organization.id, communication.id, user.id)).rejects.toThrow(
      EmailDisabledError,
    );

    const reloaded = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloaded.status).toBe("DRAFT");
    const attempts = await prisma.deliveryAttempt.count({ where: { communicationId: communication.id } });
    expect(attempts).toBe(0);
  });
});

describe("sendCommunication — concurrency", () => {
  it("Send vs Send: a double-click never results in two provider dispatches", async () => {
    const { organization, user, communication } = await setup();
    let sendCount = 0;
    const provider: EmailProvider = {
      name: "counting",
      async send() {
        sendCount += 1;
        return { provider: "counting" };
      },
    };

    const [first, second] = await Promise.allSettled([
      sendCommunication(organization.id, communication.id, user.id, { provider }),
      sendCommunication(organization.id, communication.id, user.id, { provider }),
    ]);

    const fulfilledCount = [first, second].filter((r) => r.status === "fulfilled").length;
    expect(fulfilledCount).toBe(1);
    expect(sendCount).toBe(1);

    const attempts = await prisma.deliveryAttempt.count({ where: { communicationId: communication.id } });
    expect(attempts).toBe(1);

    const rejected = [first, second].find((r) => r.status === "rejected");
    if (rejected && rejected.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(InvalidCommunicationTransitionError);
    }
  });

  it("Retry vs Retry: two concurrent retries after a FAILED send never both dispatch", async () => {
    const { organization, user, communication } = await setup();
    await sendCommunication(organization.id, communication.id, user.id, {
      provider: createFakeEmailProvider({ kind: "rejected", message: "no such mailbox" }),
    });

    let sendCount = 0;
    const provider: EmailProvider = {
      name: "counting",
      async send() {
        sendCount += 1;
        return { provider: "counting" };
      },
    };

    const [first, second] = await Promise.allSettled([
      sendCommunication(organization.id, communication.id, user.id, { provider }),
      sendCommunication(organization.id, communication.id, user.id, { provider }),
    ]);

    const fulfilledCount = [first, second].filter((r) => r.status === "fulfilled").length;
    expect(fulfilledCount).toBe(1);
    expect(sendCount).toBe(1);

    // One FAILED attempt (#1) plus exactly one more from the retry race (#2) — never three.
    const attempts = await prisma.deliveryAttempt.count({ where: { communicationId: communication.id } });
    expect(attempts).toBe(2);
  });

  it("Send vs Edit: whatever was actually dispatched always matches what's persisted, regardless of interleaving", async () => {
    const { organization, user, communication } = await setup();
    let received: EmailMessage | null = null;
    const provider: EmailProvider = {
      name: "spy",
      async send(message) {
        received = message;
        return { provider: "spy" };
      },
    };

    const [sendResult, editResult] = await Promise.allSettled([
      sendCommunication(organization.id, communication.id, user.id, { provider }),
      updateCommunicationDraft(organization.id, communication.id, {
        subject: "Raced subject",
        body: "Raced body.",
      }),
    ]);

    // Send never loses this particular race (editing alone can't move
    // status out of DRAFT), so it always succeeds.
    expect(sendResult.status).toBe("fulfilled");
    if (editResult.status === "rejected") {
      expect(editResult.reason).toBeInstanceOf(InvalidCommunicationTransitionError);
    }

    const finalCommunication = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(received).not.toBeNull();
    // Whichever content was persisted at the moment of claim is exactly
    // what got sent — never a stale read, never a silently different body.
    expect(received!.subject).toBe(finalCommunication.subject);
    expect(received!.text).toBe(finalCommunication.body);
  });
});
