import { beforeEach, describe, expect, it } from "vitest";

import { approveActionProposal } from "@/server/operator/approval";
import { detectInvoiceOverdueEvents } from "@/server/operator/events";
import { ensureInsightForInvoiceOverdueEvent } from "@/server/operator/insights";
import { ensureReminderProposalForInsight } from "@/server/operator/proposals";
import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { EmailDisabledError, EmailProviderRejectedError } from "@/server/email/errors";
import { createFakeEmailProvider } from "@/server/email/providers/fake";
import type { EmailMessage, EmailProvider } from "@/server/email/types";
import { MessagingDisabledError } from "@/server/messaging/errors";
import { createFakeMessagingProvider } from "@/server/messaging/providers/fake";
import type { MessagingMessage, MessagingProvider } from "@/server/messaging/types";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { RateLimitExceededError } from "@/server/rate-limit/errors";
import { communicationSendPolicy } from "@/server/rate-limit/policies";
import { checkRateLimit } from "@/server/rate-limit/service";
import { prepareReminderCommunication } from "./draft";
import { updateCommunicationDraft } from "./editing";
import { CommunicationResourceNotFoundError, InvalidCommunicationTransitionError } from "./errors";
import { reconcileStaleSendingCommunication, sendCommunication, STALE_SENDING_THRESHOLD_MS } from "./send";

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

async function setupTelegram() {
  const { organization, user } = await createTestOrganization();
  const customer = await createCustomer(organization.id, { name: "Acme Co" });
  // telegramChatId isn't part of customerInputSchema's create path used
  // above by design (it's set separately, mirroring how a real user fills
  // in the customer form) — set it directly for the test.
  await prisma.customer.update({ where: { id: customer.id }, data: { telegramChatId: "555000111" } });
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

describe("sendCommunication — Telegram channel", () => {
  it("drafts with channel=TELEGRAM and recipient=the customer's chat id", async () => {
    const { communication } = await setupTelegram();
    expect(communication.channel).toBe("TELEGRAM");
    expect(communication.recipient).toBe("555000111");
  });

  it("sends via the MessagingProvider, folding the subject into the message text (Telegram has no subject line)", async () => {
    const { organization, user, communication } = await setupTelegram();
    let received: MessagingMessage | null = null;
    const provider: MessagingProvider = {
      name: "spy",
      async send(message) {
        received = message;
        return { provider: "spy" };
      },
    };

    const result = await sendCommunication(organization.id, communication.id, user.id, {
      messagingProvider: provider,
    });

    expect(result.communication.status).toBe("SENT");
    expect(received).not.toBeNull();
    expect(received!.to).toBe(communication.recipient);
    expect(received!.text).toContain(communication.subject);
    expect(received!.text).toContain(communication.body);
  });

  it("marks FAILED on a definite MessagingProviderRejectedError, and does not execute the proposal", async () => {
    const { organization, user, proposal, communication } = await setupTelegram();
    const provider = createFakeMessagingProvider({ kind: "rejected", message: "chat not found" });

    const result = await sendCommunication(organization.id, communication.id, user.id, {
      messagingProvider: provider,
    });

    expect(result.communication.status).toBe("FAILED");
    expect(result.deliveryAttempt.failureCategory).toBe("PROVIDER_REJECTED");
    const reloadedProposal = await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(reloadedProposal.status).toBe("APPROVED");
  });

  it("marks UNCERTAIN (never FAILED) on an unrecognized Telegram error — the same unknown-outcome discipline as email", async () => {
    const { organization, user, communication } = await setupTelegram();
    const provider = createFakeMessagingProvider({ kind: "error", message: "ECONNRESET" });

    const result = await sendCommunication(organization.id, communication.id, user.id, {
      messagingProvider: provider,
    });

    expect(result.communication.status).toBe("UNCERTAIN");
    expect(result.deliveryAttempt.status).toBe("UNKNOWN");
  });

  it("throws MessagingDisabledError and makes no state changes when MESSAGING_PROVIDER=none (the test/CI default)", async () => {
    const { organization, user, communication } = await setupTelegram();

    await expect(sendCommunication(organization.id, communication.id, user.id)).rejects.toThrow(
      MessagingDisabledError,
    );

    const reloaded = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloaded.status).toBe("DRAFT");
    const attempts = await prisma.deliveryAttempt.count({ where: { communicationId: communication.id } });
    expect(attempts).toBe(0);
  });

  it("Send vs Send: a double-click on a Telegram communication never results in two provider dispatches", async () => {
    const { organization, user, communication } = await setupTelegram();
    let sendCount = 0;
    const provider: MessagingProvider = {
      name: "counting",
      async send() {
        sendCount += 1;
        return { provider: "counting" };
      },
    };

    const [first, second] = await Promise.allSettled([
      sendCommunication(organization.id, communication.id, user.id, { messagingProvider: provider }),
      sendCommunication(organization.id, communication.id, user.id, { messagingProvider: provider }),
    ]);

    const fulfilledCount = [first, second].filter((r) => r.status === "fulfilled").length;
    expect(fulfilledCount).toBe(1);
    expect(sendCount).toBe(1);
  });
});

describe("sendCommunication — actor source", () => {
  it("records source=USER by default, and source=AUTOMATION when explicitly passed", async () => {
    const { organization, user, invoice, communication } = await setup();

    await sendCommunication(organization.id, communication.id, user.id, {
      provider: createFakeEmailProvider({ kind: "success" }),
      actorSource: "AUTOMATION",
    });

    const events = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, invoiceId: invoice.id, type: "COMMUNICATION_SENT" },
    });
    expect(events).toHaveLength(1);
    expect((events[0]!.metadata as { source?: string } | null)?.source).toBe("AUTOMATION");
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

/**
 * Directly simulates the crash scenario reconciliation exists for: a
 * `Communication` claimed to `SENDING` whose process died before
 * `finalizeSuccess`/`finalizeTerminal` ever ran, leaving a `PENDING`
 * `DeliveryAttempt` with no terminal outcome. Bypasses `sendCommunication`
 * entirely (rather than racing a controlled provider promise) so the
 * attempt's `startedAt` can be set precisely, independent of wall-clock
 * timing — see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-3.
 */
async function simulateStuckSending(organizationId: string, communicationId: string, startedAt: Date) {
  await prisma.communication.update({ where: { id: communicationId }, data: { status: "SENDING" } });
  return prisma.deliveryAttempt.create({
    data: {
      organizationId,
      communicationId,
      attemptNumber: 1,
      provider: "test",
      idempotencyKey: `${communicationId}:stuck`,
      status: "PENDING",
      startedAt,
    },
  });
}

describe("reconcileStaleSendingCommunication", () => {
  it("refuses a SENDING communication whose attempt is still within the stale threshold", async () => {
    const { organization, communication } = await setup();
    await simulateStuckSending(organization.id, communication.id, new Date());

    await expect(reconcileStaleSendingCommunication(organization.id, communication.id)).rejects.toThrow(
      InvalidCommunicationTransitionError,
    );

    const reloaded = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloaded.status).toBe("SENDING");
    const attempt = await prisma.deliveryAttempt.findFirstOrThrow({ where: { communicationId: communication.id } });
    expect(attempt.status).toBe("PENDING");
  });

  it("reconciles a genuinely stale SENDING communication to UNCERTAIN", async () => {
    const { organization, communication } = await setup();
    const startedAt = new Date(Date.now() - STALE_SENDING_THRESHOLD_MS - 1000);
    await simulateStuckSending(organization.id, communication.id, startedAt);

    const result = await reconcileStaleSendingCommunication(organization.id, communication.id);

    expect(result.communication.status).toBe("UNCERTAIN");
    expect(result.deliveryAttempt.status).toBe("UNKNOWN");
    expect(result.deliveryAttempt.failureCategory).toBe("TIMEOUT_OR_UNKNOWN");
    expect(result.deliveryAttempt.completedAt).not.toBeNull();

    const events = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, type: "COMMUNICATION_SEND_FAILED" },
    });
    expect(events).toHaveLength(1);
    expect((events[0]!.metadata as { reconciledFromStaleSending?: boolean } | null)?.reconciledFromStaleSending).toBe(
      true,
    );
  });

  it("never resends by itself — actually resending after reconciliation still requires explicit acknowledgement", async () => {
    const { organization, user, communication } = await setup();
    const startedAt = new Date(Date.now() - STALE_SENDING_THRESHOLD_MS - 1000);
    await simulateStuckSending(organization.id, communication.id, startedAt);
    await reconcileStaleSendingCommunication(organization.id, communication.id);

    // Reconciling only admits the outcome is unknown — it must never itself
    // dispatch anything, and the ordinary UNCERTAIN-without-acknowledgement
    // guard must still apply afterward exactly as it does for any other
    // UNCERTAIN outcome.
    await expect(
      sendCommunication(organization.id, communication.id, user.id, {
        provider: createFakeEmailProvider({ kind: "success" }),
      }),
    ).rejects.toThrow(InvalidCommunicationTransitionError);

    const result = await sendCommunication(organization.id, communication.id, user.id, {
      provider: createFakeEmailProvider({ kind: "success" }),
      acknowledgeUncertainRisk: true,
    });
    expect(result.communication.status).toBe("SENT");
    expect(result.deliveryAttempt.attemptNumber).toBe(2);
  });

  it("only lets one of two concurrent reconcile attempts succeed", async () => {
    const { organization, communication } = await setup();
    const startedAt = new Date(Date.now() - STALE_SENDING_THRESHOLD_MS - 1000);
    await simulateStuckSending(organization.id, communication.id, startedAt);

    const [first, second] = await Promise.allSettled([
      reconcileStaleSendingCommunication(organization.id, communication.id),
      reconcileStaleSendingCommunication(organization.id, communication.id),
    ]);

    const fulfilledCount = [first, second].filter((r) => r.status === "fulfilled").length;
    expect(fulfilledCount).toBe(1);
    const rejected = [first, second].find((r) => r.status === "rejected");
    if (rejected && rejected.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(InvalidCommunicationTransitionError);
    }

    const reloaded = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloaded.status).toBe("UNCERTAIN");
  });

  it("rejects reconciling another organization's communication", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB, user: userB } = await createTestOrganization("Org B");
    const customerB = await createCustomer(orgB.id, { name: "B Customer", email: "b@example.com" });
    const { communication } = await createDraftCommunication(orgB.id, userB.id, customerB.id);
    const startedAt = new Date(Date.now() - STALE_SENDING_THRESHOLD_MS - 1000);
    await simulateStuckSending(orgB.id, communication.id, startedAt);

    await expect(reconcileStaleSendingCommunication(orgA.id, communication.id)).rejects.toThrow(
      CommunicationResourceNotFoundError,
    );

    const reloaded = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloaded.status).toBe("SENDING");
  });

  it("updates the actual PENDING attempt, not an earlier terminal one, when reconciling after a prior FAILED attempt", async () => {
    const { organization, communication } = await setup();

    // Build attempt #1 as a real FAILED attempt against this communication,
    // then attempt #2 as the stuck PENDING one — reconcile must touch #2 only.
    const failed = await prisma.deliveryAttempt.create({
      data: {
        organizationId: organization.id,
        communicationId: communication.id,
        attemptNumber: 1,
        provider: "test",
        idempotencyKey: `${communication.id}:1`,
        status: "FAILED",
        failureCategory: "PROVIDER_REJECTED",
        failureMessage: "no such mailbox",
        completedAt: new Date(Date.now() - STALE_SENDING_THRESHOLD_MS - 5000),
      },
    });
    const startedAt = new Date(Date.now() - STALE_SENDING_THRESHOLD_MS - 1000);
    await prisma.communication.update({ where: { id: communication.id }, data: { status: "SENDING" } });
    const pending = await prisma.deliveryAttempt.create({
      data: {
        organizationId: organization.id,
        communicationId: communication.id,
        attemptNumber: 2,
        provider: "test",
        idempotencyKey: `${communication.id}:2`,
        status: "PENDING",
        startedAt,
      },
    });

    const result = await reconcileStaleSendingCommunication(organization.id, communication.id);

    expect(result.deliveryAttempt.id).toBe(pending.id);
    const reloadedFailed = await prisma.deliveryAttempt.findUniqueOrThrow({ where: { id: failed.id } });
    expect(reloadedFailed.status).toBe("FAILED"); // untouched
  });
});

describe("sendCommunication — provider abuse control / send rate limit (P1-7)", () => {
  // The loop below performs `policy.maxAttempts` (100 by default) real
  // sequential DB round trips before the actual assertion — needs more
  // than vitest's default 5000ms, same as src/server/auth/authenticate.test.ts.
  it("refuses to send once the organization's hourly send budget is exhausted, making no state changes", async () => {
    const { organization, user, communication } = await setup();

    const policy = communicationSendPolicy();
    for (let i = 0; i < policy.maxAttempts; i += 1) {
      await checkRateLimit("communication:send", organization.id, policy);
    }

    await expect(
      sendCommunication(organization.id, communication.id, user.id, {
        provider: createFakeEmailProvider({ kind: "success" }),
      }),
    ).rejects.toThrow(RateLimitExceededError);

    const reloaded = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloaded.status).toBe("DRAFT"); // no claim, no DeliveryAttempt — blocked before any state change
    const attempts = await prisma.deliveryAttempt.count({ where: { communicationId: communication.id } });
    expect(attempts).toBe(0);
  }, 20000);

  it("applies uniformly to AUTOMATION-sourced sends, not just USER ones (the point is a total org cost ceiling)", async () => {
    const { organization, user, communication } = await setup();

    const policy = communicationSendPolicy();
    for (let i = 0; i < policy.maxAttempts; i += 1) {
      await checkRateLimit("communication:send", organization.id, policy);
    }

    await expect(
      sendCommunication(organization.id, communication.id, user.id, {
        provider: createFakeEmailProvider({ kind: "success" }),
        actorSource: "AUTOMATION",
      }),
    ).rejects.toThrow(RateLimitExceededError);
  }, 20000);

  it("a different organization's send budget is unaffected by another organization's exhausted limit", async () => {
    const { organization: orgA, user: userA, communication: commA } = await setup();
    const { organization: orgB, user: userB, communication: commB } = await setup();

    const policy = communicationSendPolicy();
    for (let i = 0; i < policy.maxAttempts; i += 1) {
      await checkRateLimit("communication:send", orgA.id, policy);
    }

    await expect(
      sendCommunication(orgA.id, commA.id, userA.id, { provider: createFakeEmailProvider({ kind: "success" }) }),
    ).rejects.toThrow(RateLimitExceededError);

    const resultB = await sendCommunication(orgB.id, commB.id, userB.id, {
      provider: createFakeEmailProvider({ kind: "success" }),
    });
    expect(resultB.communication.status).toBe("SENT"); // org B's budget is untouched
  }, 20000);
});

describe("sendCommunication vs reconcileStaleSendingCommunication — late-arriving outcome race (adversarial self-review finding)", () => {
  it("a late-arriving SUCCESS for an attempt that was already reconciled never overwrites the reconciled state", async () => {
    const { organization, user, communication } = await setup();
    let releaseProvider: (() => void) | null = null;
    const stuckProvider: EmailProvider = {
      name: "stuck",
      send: () =>
        new Promise((resolve) => {
          releaseProvider = () => resolve({ provider: "stuck", providerMessageId: "late-msg" });
        }),
    };

    // Claim the communication and start a dispatch that never resolves on
    // its own — simulating a provider call that outlives its own gateway
    // timeout (the only realistic way a claimed attempt is still PENDING
    // once it becomes eligible for stale-SENDING reconciliation).
    const inFlightSend = sendCommunication(organization.id, communication.id, user.id, { provider: stuckProvider });
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the claim transaction commit

    // Reconcile it as stale (using `now` far enough ahead — no real wait).
    const farFuture = new Date(Date.now() + 11 * 60 * 1000);
    const reconciled = await reconcileStaleSendingCommunication(organization.id, communication.id, farFuture);
    expect(reconciled.communication.status).toBe("UNCERTAIN");
    expect(reconciled.deliveryAttempt.status).toBe("UNKNOWN");

    // NOW the original, still-in-flight provider call finally resolves —
    // finalizeSuccess runs against a Communication/DeliveryAttempt that
    // have since moved on.
    releaseProvider!();
    const staleResult = await inFlightSend;

    // The late result must reflect the *current, authoritative* state —
    // never silently claim SENT.
    expect(staleResult.communication.status).toBe("UNCERTAIN");
    expect(staleResult.deliveryAttempt.status).toBe("UNKNOWN");
    expect(staleResult.actionProposal).toBeNull();

    // And the persisted rows must genuinely be untouched by the late success.
    const reloadedCommunication = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloadedCommunication.status).toBe("UNCERTAIN");
    expect(reloadedCommunication.sentAt).toBeNull();
    const reloadedAttempt = await prisma.deliveryAttempt.findUniqueOrThrow({
      where: { id: reconciled.deliveryAttempt.id },
    });
    expect(reloadedAttempt.status).toBe("UNKNOWN");
    expect(reloadedAttempt.providerMessageId).toBeNull(); // never backfilled by the discarded late success
  });

  it("a late-arriving definite FAILURE for an attempt that was already reconciled never overwrites the reconciled state", async () => {
    const { organization, user, communication } = await setup();
    let rejectProvider: (() => void) | null = null;
    const stuckProvider: EmailProvider = {
      name: "stuck",
      send: () =>
        new Promise((_resolve, reject) => {
          rejectProvider = () => reject(new EmailProviderRejectedError("stuck", "mailbox does not exist"));
        }),
    };

    const inFlightSend = sendCommunication(organization.id, communication.id, user.id, { provider: stuckProvider });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const farFuture = new Date(Date.now() + 11 * 60 * 1000);
    await reconcileStaleSendingCommunication(organization.id, communication.id, farFuture);

    rejectProvider!();
    const staleResult = await inFlightSend;

    expect(staleResult.communication.status).toBe("UNCERTAIN"); // never flipped to FAILED by the late rejection
    const reloadedCommunication = await prisma.communication.findUniqueOrThrow({ where: { id: communication.id } });
    expect(reloadedCommunication.status).toBe("UNCERTAIN");
  });
});
