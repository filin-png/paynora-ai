import type {
  ActionProposal,
  Communication,
  CommunicationStatus,
  DeliveryAttempt,
  DeliveryFailureCategory,
} from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";
import { EmailProviderRejectedError } from "@/server/email/errors";
import { dispatchEmail } from "@/server/email/gateway";
import { getSenderAddress, resolveEmailProvider } from "@/server/email/service";
import type { EmailProvider } from "@/server/email/types";
import { MessagingProviderRejectedError } from "@/server/messaging/errors";
import { dispatchMessage } from "@/server/messaging/gateway";
import { resolveMessagingProvider } from "@/server/messaging/service";
import type { MessagingProvider } from "@/server/messaging/types";
import { RateLimitExceededError } from "@/server/rate-limit/errors";
import { communicationSendPolicy } from "@/server/rate-limit/policies";
import { checkRateLimit } from "@/server/rate-limit/service";
import { CommunicationResourceNotFoundError, InvalidCommunicationTransitionError } from "./errors";

/** Who actually triggered this send — encoded in the ActivityEvent's metadata, not a schema change. See docs/communications.md#audit-trail. */
export type CommunicationActorSource = "USER" | "AUTOMATION";

export type SendCommunicationOptions = {
  /**
   * Must be true when the communication's current status is UNCERTAIN.
   * There is no other way to resend from UNCERTAIN — see
   * docs/communications.md#unknown-outcomes. Has no effect from any other
   * status (DRAFT/FAILED are always retryable without it).
   */
  acknowledgeUncertainRisk?: boolean;
  /**
   * Test-only dependency injection point. Production code paths never
   * pass this — they always go through `resolveEmailProvider()`, which is
   * what enforces EMAIL_PROVIDER/PAYNORA_EMAIL_FROM configuration. Tests
   * use it to exercise success/rejection/timeout outcomes deterministically
   * via src/server/email/providers/fake.ts without a real network call —
   * see src/server/communications/send.test.ts.
   */
  provider?: EmailProvider;
  /** Same test-only injection point, for the TELEGRAM channel — see src/server/messaging/providers/fake.ts. */
  messagingProvider?: MessagingProvider;
  /** Defaults to "USER" — src/server/collections/engine.ts's executeAutoSend passes "AUTOMATION". */
  actorSource?: CommunicationActorSource;
};

type DispatchOutcome = { providerName: string; providerMessageId?: string };

/**
 * The one place `sendCommunication` actually calls a provider — branches on
 * `communication.channel`, but both branches feed the exact same
 * claim/finalize state machine below, so every existing guarantee (atomic
 * claim, UNCERTAIN-on-ambiguous-outcome, no auto-retry) applies identically
 * regardless of channel. Telegram has no subject line, so the subject is
 * folded into the message text rather than silently dropped.
 */
async function dispatchByChannel(
  communication: Communication,
  idempotencyKey: string,
  from: string,
  emailProvider: EmailProvider,
  messagingProvider: MessagingProvider | null,
): Promise<DispatchOutcome> {
  if (communication.channel === "EMAIL") {
    const result = await dispatchEmail(emailProvider, {
      to: communication.recipient,
      from,
      subject: communication.subject,
      text: communication.body,
      idempotencyKey,
    });
    return { providerName: result.provider, providerMessageId: result.providerMessageId };
  }

  // communication.channel === "TELEGRAM". Resolved and validated before the
  // claim step below (see sendCommunication) — reaching here with no
  // provider would be a programming error, not a runtime possibility.
  if (!messagingProvider) throw new Error("Telegram communication claimed without a resolved MessagingProvider");
  const result = await dispatchMessage(messagingProvider, {
    to: communication.recipient,
    text: `${communication.subject}\n\n${communication.body}`,
    idempotencyKey,
  });
  return { providerName: result.provider, providerMessageId: result.providerMessageId };
}

export type SendCommunicationResult = {
  communication: Communication;
  deliveryAttempt: DeliveryAttempt;
  /** Set only when this call is the one that moved the proposal to EXECUTED. */
  actionProposal: ActionProposal | null;
};

export async function listDeliveryAttempts(organizationId: string, communicationId: string) {
  return prisma.deliveryAttempt.findMany({
    where: { organizationId, communicationId },
    orderBy: { attemptNumber: "asc" },
  });
}

/**
 * How long a `Communication` can sit at `SENDING` with its most recent
 * `DeliveryAttempt` still `PENDING` before it's treated as genuinely
 * stuck (a process crash between claim and finalize — see the module doc
 * comment above) rather than a request that might still be in flight.
 * Comfortably larger than the longest real provider timeout in this
 * codebase (Email/Messaging: 15s) — see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md
 * P1-3.
 */
export const STALE_SENDING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export type ReconcileStaleSendingResult = {
  communication: Communication;
  deliveryAttempt: DeliveryAttempt;
};

/**
 * The recovery path for a `Communication` genuinely stuck at `SENDING` —
 * see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-3 for the finding
 * this closes: previously, `SENDING` was excluded from every
 * `allowedFrom` list in `sendCommunication` *forever*, with no way back
 * in, and the Action Center UI offered a "Resend anyway" button for that
 * exact state that was guaranteed to fail.
 *
 * This does NOT resend anything and does NOT decide whether the original
 * attempt actually reached the customer — a provider may well have
 * accepted the message before the process died. It only moves the
 * communication from the permanently-stuck `SENDING` state to the
 * already-well-understood `UNCERTAIN` state, which — exactly like any
 * other `UNCERTAIN` outcome — still requires an explicit
 * `acknowledgeUncertainRisk: true` from a human before `sendCommunication`
 * will attempt anything further. This function is the "admit we don't
 * know" step; resending (accepting the duplicate-send risk) remains a
 * deliberate, separate, already-existing, already-tested step.
 *
 * Refuses to act on a `SENDING` communication whose most recent attempt
 * is still within `STALE_SENDING_THRESHOLD_MS` — a fresh `SENDING` might
 * genuinely still be in flight, and reconciling it early would be an
 * unsafe, premature judgment call.
 *
 * Concurrency-safe via the same atomic compare-and-swap technique used
 * throughout this codebase: the `SENDING -> UNCERTAIN` transition only
 * commits if the row is still `SENDING` at that instant, so two
 * concurrent reconcile attempts (or a reconcile racing the original
 * attempt actually completing) can never both "win", and can never
 * silently overwrite a `SENT`/`FAILED` outcome that landed in between.
 */
export async function reconcileStaleSendingCommunication(
  organizationId: string,
  communicationId: string,
  now: Date = new Date(),
): Promise<ReconcileStaleSendingResult> {
  const communication = await prisma.communication.findFirst({ where: { id: communicationId, organizationId } });
  if (!communication) throw new CommunicationResourceNotFoundError("Communication");
  if (communication.status !== "SENDING") {
    throw new InvalidCommunicationTransitionError(
      communication.status,
      "only a communication currently stuck at SENDING can be reconciled",
    );
  }

  const pendingAttempt = await prisma.deliveryAttempt.findFirst({
    where: { communicationId, organizationId, status: "PENDING" },
    orderBy: { attemptNumber: "desc" },
  });
  if (!pendingAttempt) {
    throw new InvalidCommunicationTransitionError(
      communication.status,
      "no pending delivery attempt was found to reconcile",
    );
  }

  const ageMs = now.getTime() - pendingAttempt.startedAt.getTime();
  if (ageMs < STALE_SENDING_THRESHOLD_MS) {
    throw new InvalidCommunicationTransitionError(
      communication.status,
      `this send attempt started only ${Math.round(ageMs / 1000)}s ago and may still be genuinely in flight — wait before reconciling`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const claim = await tx.communication.updateMany({
      where: { id: communicationId, organizationId, status: "SENDING" },
      data: { status: "UNCERTAIN" },
    });
    if (claim.count !== 1) {
      const current = await tx.communication.findFirst({ where: { id: communicationId, organizationId } });
      if (!current) throw new CommunicationResourceNotFoundError("Communication");
      throw new InvalidCommunicationTransitionError(
        current.status,
        "this communication is no longer stuck at SENDING — it may have just been reconciled or resolved concurrently",
      );
    }

    const updatedAttempt = await tx.deliveryAttempt.update({
      where: { id: pendingAttempt.id },
      data: {
        status: "UNKNOWN",
        failureCategory: "TIMEOUT_OR_UNKNOWN",
        failureMessage: `No delivery confirmation was observed within ${Math.round(STALE_SENDING_THRESHOLD_MS / 60000)} minutes of this attempt starting — the provider may or may not have received it. Reconciled to allow manual review; never auto-retried.`,
        completedAt: now,
      },
    });
    const updatedCommunication = await tx.communication.findUniqueOrThrow({ where: { id: communicationId } });

    await recordActivityEvent(tx, {
      organizationId,
      type: "COMMUNICATION_SEND_FAILED",
      summary: `Payment reminder delivery status reconciled to uncertain for invoice ${updatedCommunication.invoiceId} (stuck at SENDING with no resolution)`,
      customerId: updatedCommunication.customerId,
      invoiceId: updatedCommunication.invoiceId,
      metadata: { outcome: "UNCERTAIN", failureCategory: "TIMEOUT_OR_UNKNOWN", reconciledFromStaleSending: true },
    });

    return { communication: updatedCommunication, deliveryAttempt: updatedAttempt };
  });
}

const ALWAYS_SENDABLE_FROM: CommunicationStatus[] = ["DRAFT", "FAILED"];
const UNCERTAIN_SENDABLE_FROM: CommunicationStatus[] = ["DRAFT", "FAILED", "UNCERTAIN"];

/**
 * The one function that ever calls an EmailProvider. Two-phase by design
 * — see docs/communications.md#delivery-semantics for why a single DB
 * transaction cannot safely wrap the external call:
 *
 * 1. Atomically claim the communication (DRAFT/FAILED[/UNCERTAIN with
 *    `acknowledgeUncertainRisk`] -> SENDING) and create a PENDING
 *    DeliveryAttempt, in one transaction. Only one of any number of
 *    concurrent callers can win this claim — Postgres serializes
 *    concurrent UPDATEs on the same row and re-evaluates the WHERE clause
 *    against the winner's committed state (same technique as
 *    src/server/operator/approval.ts's PENDING -> APPROVED/DISMISSED
 *    fix) — so a double-click or two concurrent requests can never both
 *    reach step 2; the loser gets a clear
 *    InvalidCommunicationTransitionError instead.
 * 2. Call the EmailProvider *outside* any transaction, using the content
 *    this call just claimed (never a stale read — see
 *    src/server/communications/editing.ts for why a concurrent edit can't
 *    smuggle different content in here).
 * 3. Record the outcome in a second transaction: a confirmed success ->
 *    SENT (and the ActionProposal -> EXECUTED, the only place that
 *    happens); a definite `EmailProviderRejectedError` -> FAILED;
 *    anything else (timeout, network error, unrecognized exception) ->
 *    UNCERTAIN — never treated as a confirmed failure, never
 *    auto-retried.
 *
 * If step 3 itself fails to commit after a successful provider call
 * (process crash, DB outage), the row is left at SENDING — which the
 * Action Center treats identically to UNCERTAIN, since a resting
 * `SENDING` a user can actually see is definitionally stuck (a live
 * in-flight request blocks the Server Action that would show it). This
 * is a documented, accepted limitation, not a solved problem: without an
 * outbox/reconciler — explicitly out of scope for Phase 4 (no
 * schedulers) — no single-process app can make a stronger guarantee
 * here. See docs/communications.md#unknown-outcomes.
 */
export async function sendCommunication(
  organizationId: string,
  communicationId: string,
  userId: string,
  options: SendCommunicationOptions = {},
): Promise<SendCommunicationResult> {
  // Which channel this communication uses is read once, up front, and
  // determines which provider must be resolved/validated below — a
  // tenant-scoped read, not a write, so it doesn't itself claim anything.
  const channelLookup = await prisma.communication.findFirst({
    where: { id: communicationId, organizationId },
    select: { channel: true },
  });
  if (!channelLookup) throw new CommunicationResourceNotFoundError("Communication");

  // Resolved and validated *before* any state changes — a misconfigured
  // or disabled provider must never create a DeliveryAttempt or move the
  // communication into SENDING. See docs/communications.md#sender-safety.
  const emailProvider = channelLookup.channel === "EMAIL" ? (options.provider ?? resolveEmailProvider()) : null;
  const from = channelLookup.channel === "EMAIL" ? getSenderAddress() : null;
  const messagingProvider =
    channelLookup.channel === "TELEGRAM" ? (options.messagingProvider ?? resolveMessagingProvider()) : null;
  const providerName = (channelLookup.channel === "EMAIL" ? emailProvider?.name : messagingProvider?.name)!;

  // Bounds real provider dispatch volume/cost per organization per hour —
  // see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-7. Checked here,
  // before any state change, for the same reason provider resolution is:
  // a blocked send must never create a DeliveryAttempt or move the
  // communication into SENDING. Applies uniformly to USER and AUTOMATION
  // sends — the point is a total-cost ceiling for the organization
  // regardless of what triggered the send. Fails closed (throws) on an
  // unexpected rate-limiter error, consistent with every other rate limit
  // in this codebase.
  //
  // A genuine retry (after FAILED, or UNCERTAIN with acknowledgement) is
  // a new real dispatch and correctly consumes a new slot each time. The
  // one case this doesn't perfectly account for is two truly concurrent
  // duplicate requests (e.g. a double-click) that both reach this check
  // before either wins the claim below — the loser still consumes a slot
  // even though it never dispatches anything. That's an accepted,
  // documented imprecision (at most one wasted slot per genuine race, not
  // a correctness bug) rather than moving this check after the claim,
  // which would require inventing a new terminal DeliveryAttempt outcome
  // for "claimed but blocked before dispatch" — not justified by an edge
  // case this narrow.
  const sendLimit = await checkRateLimit("communication:send", organizationId, communicationSendPolicy());
  if (!sendLimit.allowed) {
    throw new RateLimitExceededError(
      sendLimit.resetAt,
      "This organization has reached its hourly limit for sending reminders. Please try again later.",
    );
  }

  const allowedFrom = options.acknowledgeUncertainRisk ? UNCERTAIN_SENDABLE_FROM : ALWAYS_SENDABLE_FROM;
  const actorSource: CommunicationActorSource = options.actorSource ?? "USER";
  const channelLabel = channelLookup.channel === "EMAIL" ? "email" : "Telegram message";

  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.communication.updateMany({
      where: { id: communicationId, organizationId, status: { in: allowedFrom } },
      data: { status: "SENDING" },
    });

    if (claim.count !== 1) {
      const current = await tx.communication.findFirst({ where: { id: communicationId, organizationId } });
      if (!current) throw new CommunicationResourceNotFoundError("Communication");
      if (current.status === "UNCERTAIN" && !options.acknowledgeUncertainRisk) {
        throw new InvalidCommunicationTransitionError(
          current.status,
          "resending after an uncertain delivery outcome requires explicit acknowledgement that this may send a duplicate email",
        );
      }
      if (current.status === "SENDING") {
        throw new InvalidCommunicationTransitionError(
          current.status,
          "a send is already in progress, or a previous attempt never finished recording its outcome — this is not safe to retry automatically",
        );
      }
      throw new InvalidCommunicationTransitionError(current.status, "cannot send from this status");
    }

    const communication = await tx.communication.findUniqueOrThrow({ where: { id: communicationId } });
    const attemptNumber = (await tx.deliveryAttempt.count({ where: { communicationId } })) + 1;

    const deliveryAttempt = await tx.deliveryAttempt.create({
      data: {
        organizationId,
        communicationId,
        attemptNumber,
        provider: providerName,
        idempotencyKey: `${communicationId}:${attemptNumber}`,
        status: "PENDING",
      },
    });

    await recordActivityEvent(tx, {
      organizationId,
      type: "COMMUNICATION_SEND_ATTEMPTED",
      summary: `Payment reminder ${channelLabel} send attempt #${attemptNumber} started for invoice ${communication.invoiceId}`,
      customerId: communication.customerId,
      invoiceId: communication.invoiceId,
      metadata: { attemptNumber, source: actorSource },
    });

    return { communication, deliveryAttempt };
  });

  const { communication, deliveryAttempt } = claimed;

  try {
    const result = await dispatchByChannel(
      communication,
      deliveryAttempt.idempotencyKey,
      from ?? "",
      emailProvider as EmailProvider,
      messagingProvider,
    );
    return await finalizeSuccess(
      organizationId,
      communication,
      deliveryAttempt,
      userId,
      result.providerMessageId,
      actorSource,
    );
  } catch (error) {
    if (error instanceof EmailProviderRejectedError || error instanceof MessagingProviderRejectedError) {
      return await finalizeTerminal(organizationId, communication, deliveryAttempt, {
        deliveryStatus: "FAILED",
        communicationStatus: "FAILED",
        failureCategory: "PROVIDER_REJECTED",
        failureMessage: error.message,
        outcome: "FAILED",
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return await finalizeTerminal(organizationId, communication, deliveryAttempt, {
      deliveryStatus: "UNKNOWN",
      communicationStatus: "UNCERTAIN",
      failureCategory: "TIMEOUT_OR_UNKNOWN",
      failureMessage: message,
      outcome: "UNCERTAIN",
    });
  }
}

async function finalizeSuccess(
  organizationId: string,
  communication: Communication,
  deliveryAttempt: DeliveryAttempt,
  userId: string,
  providerMessageId: string | undefined,
  actorSource: CommunicationActorSource,
): Promise<SendCommunicationResult> {
  const channelLabel = communication.channel === "EMAIL" ? "email" : "Telegram message";
  return prisma.$transaction(async (tx) => {
    const updatedAttempt = await tx.deliveryAttempt.update({
      where: { id: deliveryAttempt.id },
      data: { status: "SUCCESS", providerMessageId, completedAt: new Date() },
    });
    const updatedCommunication = await tx.communication.update({
      where: { id: communication.id },
      data: { status: "SENT", sentAt: new Date() },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "COMMUNICATION_SENT",
      summary: `Payment reminder ${channelLabel} sent for invoice ${communication.invoiceId}`,
      customerId: communication.customerId,
      invoiceId: communication.invoiceId,
      metadata: { source: actorSource },
    });

    // Only a *confirmed successful send* executes the proposal — approving
    // never does (Phase 3), and a failed/uncertain send never does
    // either. Compare-and-swap for consistency with the rest of the
    // codebase, even though in normal operation at most one send can ever
    // succeed per communication (this function's own claim step already
    // prevents a second concurrent dispatch). Deliberately does not touch
    // decidedAt/decidedByUserId — those still record who *approved* the
    // proposal; who triggered the send is recorded on the
    // ACTION_PROPOSAL_EXECUTED activity event instead.
    let actionProposal: ActionProposal | null = null;
    const proposalUpdate = await tx.actionProposal.updateMany({
      where: { id: communication.actionProposalId, organizationId, status: "APPROVED" },
      data: { status: "EXECUTED" },
    });
    if (proposalUpdate.count === 1) {
      actionProposal = await tx.actionProposal.findUniqueOrThrow({
        where: { id: communication.actionProposalId },
      });
      await recordActivityEvent(tx, {
        organizationId,
        type: "ACTION_PROPOSAL_EXECUTED",
        summary: `Payment reminder proposal executed for invoice ${communication.invoiceId}`,
        customerId: communication.customerId,
        invoiceId: communication.invoiceId,
        metadata: { sentByUserId: userId },
      });
    }

    return { communication: updatedCommunication, deliveryAttempt: updatedAttempt, actionProposal };
  });
}

async function finalizeTerminal(
  organizationId: string,
  communication: Communication,
  deliveryAttempt: DeliveryAttempt,
  outcome: {
    deliveryStatus: "FAILED" | "UNKNOWN";
    communicationStatus: "FAILED" | "UNCERTAIN";
    failureCategory: DeliveryFailureCategory;
    failureMessage: string;
    outcome: "FAILED" | "UNCERTAIN";
  },
): Promise<SendCommunicationResult> {
  return prisma.$transaction(async (tx) => {
    const updatedAttempt = await tx.deliveryAttempt.update({
      where: { id: deliveryAttempt.id },
      data: {
        status: outcome.deliveryStatus,
        failureCategory: outcome.failureCategory,
        failureMessage: outcome.failureMessage,
        completedAt: new Date(),
      },
    });
    const updatedCommunication = await tx.communication.update({
      where: { id: communication.id },
      data: { status: outcome.communicationStatus },
    });
    const channelLabel = communication.channel === "EMAIL" ? "email" : "Telegram message";
    await recordActivityEvent(tx, {
      organizationId,
      type: "COMMUNICATION_SEND_FAILED",
      summary:
        outcome.outcome === "FAILED"
          ? `Payment reminder ${channelLabel} send failed for invoice ${communication.invoiceId}`
          : `Payment reminder ${channelLabel} delivery status uncertain for invoice ${communication.invoiceId}`,
      customerId: communication.customerId,
      invoiceId: communication.invoiceId,
      metadata: { outcome: outcome.outcome, failureCategory: outcome.failureCategory },
    });
    return { communication: updatedCommunication, deliveryAttempt: updatedAttempt, actionProposal: null };
  });
}
