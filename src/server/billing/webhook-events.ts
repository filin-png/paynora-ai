import { Prisma, type SubscriptionStatus } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";

import type { BillingSubscriptionStatus, NormalizedSubscriptionEvent } from "./types";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export type ApplySubscriptionWebhookEventResult =
  | { outcome: "applied"; organizationId: string; statusChanged: boolean }
  | { outcome: "duplicate"; organizationId: string }
  | { outcome: "unknown_organization" };

/**
 * Maps the provider-neutral webhook status vocabulary (types.ts's
 * `BillingSubscriptionStatus`) onto PAYNORA's own `SubscriptionStatus`
 * enum. Returns `null` for "incomplete" — a subscription whose first
 * payment hasn't completed yet has no PAYNORA-side status to transition
 * to (nothing was ever active); the event is still recorded in the
 * SubscriptionPayment ledger, it just never moves
 * OrganizationSubscription.status. "unpaid" (a vendor's terminal
 * failed-renewal state) maps to PAST_DUE — the same grace-period
 * treatment as a single missed payment, since PAYNORA has no separate
 * "unpaid" status of its own (see prisma/schema.prisma's
 * SubscriptionStatus).
 */
export function mapNormalizedStatus(status: BillingSubscriptionStatus): SubscriptionStatus | null {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
    case "unpaid":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    case "incomplete":
      return null;
  }
}

/**
 * Interprets a normalized webhook status as a checkout OUTCOME — a
 * different question from `mapNormalizedStatus`'s "what should the
 * subscription's status become". A checkout-linked event's "canceled"
 * means "this one payment attempt failed", which must never be applied
 * to an organization's existing, already-active subscription the same
 * way a real subscription-cancellation event would be (see
 * `applyCheckoutDrivenEvent` below) — that distinction is the entire
 * reason this is a separate function rather than reusing
 * `mapNormalizedStatus`'s result to decide what to do.
 */
function checkoutOutcomeFromStatus(status: BillingSubscriptionStatus): "SUCCEEDED" | "FAILED" | "PENDING" {
  switch (status) {
    case "active":
    case "trialing":
      return "SUCCEEDED";
    case "canceled":
      return "FAILED";
    case "incomplete":
      return "PENDING";
    case "past_due":
    case "unpaid":
      // Not a real outcome this adapter's checkout flow can produce today
      // (see providers/yookassa.ts's SUPPORTED_EVENTS) — kept exhaustive
      // and neither SUCCEEDED nor FAILED so a future provider that does
      // emit this can't be silently mis-handled either way.
      return "PENDING";
  }
}

/**
 * Applies one verified, normalized billing webhook event to durable
 * state. Two resolution paths, tried in this order:
 *
 * 1. Checkout-driven (Phase 20, `event.paymentId` set): the organization
 *    AND the plan being granted both come from the `BillingCheckoutSession`
 *    row `event.paymentId` resolves to — a row PAYNORA created itself
 *    before ever calling the vendor (see checkout.ts#createCheckoutSession)
 *    — never from anything the webhook body itself claims. This is what
 *    makes "pay for Starter, get granted Pro", "client substitutes
 *    PlanId", and "webhook claims the wrong organization" all structurally
 *    impossible here, not just validated against.
 * 2. Legacy customerId/subscriptionId-linked (Phase 18, unchanged): for
 *    any event with no `paymentId` — status-only transitions on an
 *    already-linked subscription, exactly as before Phase 20.
 *
 * Idempotent on `(provider, eventId)` in both paths: providers retry
 * webhook delivery, so the same event can arrive more than once. Every
 * event is recorded once in `SubscriptionPayment` (the audit trail — see
 * that model's doc comment) via the unique constraint doing the real
 * dedup work, not a check-then-insert race.
 */
export async function applySubscriptionWebhookEvent(
  event: NormalizedSubscriptionEvent,
): Promise<ApplySubscriptionWebhookEventResult> {
  if (event.paymentId) {
    return applyCheckoutDrivenEvent(event);
  }
  return applyLegacyLinkedEvent(event);
}

/**
 * The checkout-driven path (Phase 20) — see `applySubscriptionWebhookEvent`'s
 * doc comment for why this never trusts `event.customerId`/`subscriptionId`/
 * `planId` for anything but audit metadata.
 */
async function applyCheckoutDrivenEvent(
  event: NormalizedSubscriptionEvent,
): Promise<ApplySubscriptionWebhookEventResult> {
  const checkoutSession = await prisma.billingCheckoutSession.findUnique({
    where: { externalPaymentId: event.paymentId },
  });
  if (!checkoutSession) {
    return { outcome: "unknown_organization" };
  }
  // Defense-in-depth against a vendor-id collision across providers (e.g. a
  // migration, or two providers configured at different times): a payment
  // id is only ever meaningful within the provider that issued it.
  if (checkoutSession.provider !== event.eventIdentity.provider) {
    return { outcome: "unknown_organization" };
  }

  const nextStatus = mapNormalizedStatus(event.status);
  const checkoutOutcome = checkoutOutcomeFromStatus(event.status);

  try {
    return await prisma.$transaction(async (tx) => {
      const currentSubscription = await tx.organizationSubscription.findUniqueOrThrow({
        where: { organizationId: checkoutSession.organizationId },
      });

      await tx.subscriptionPayment.create({
        data: {
          organizationId: checkoutSession.organizationId,
          provider: event.eventIdentity.provider,
          externalEventId: event.eventIdentity.eventId,
          amountMinor: event.amountMinor ?? null,
          currency: event.currency ?? null,
          status: nextStatus ?? currentSubscription.status,
          planIdRaw: event.planId ?? checkoutSession.targetPlanId,
        },
      });

      let statusChanged = false;

      // Defense-in-depth: if the webhook reports an amount/currency at all,
      // it must match what this checkout session was actually authorized
      // for. YooKassa's amount is fixed at payment-creation time (this
      // adapter's own `createCheckout` call), so a real mismatch here would
      // mean either a vendor-side inconsistency or a payload this adapter's
      // own verification somehow let through malformed — either way, this
      // is not a payment PAYNORA should treat as "pay for Starter, get
      // granted Pro" just because the status says succeeded.
      const amountMismatch =
        event.amountMinor !== undefined &&
        (event.amountMinor !== checkoutSession.amountMinor ||
          (event.currency !== undefined && event.currency !== checkoutSession.currency));
      if (amountMismatch) {
        console.error(
          `[billing] checkout session ${checkoutSession.id} webhook reported ${event.amountMinor} ${event.currency}, but the session was authorized for ${checkoutSession.amountMinor} ${checkoutSession.currency} — refusing to grant the plan`,
        );
      }

      if (checkoutOutcome === "SUCCEEDED" && !amountMismatch) {
        // Compare-and-swap: only the delivery that actually flips this
        // checkout session PENDING -> SUCCEEDED grants the plan. A second
        // delivery for the same outcome (a distinct eventId for the same
        // payment, in principle) finds the session already SUCCEEDED and
        // skips the grant — the ledger row above still records it, but
        // the plan is never applied twice.
        const claim = await tx.billingCheckoutSession.updateMany({
          where: { id: checkoutSession.id, status: "PENDING" },
          data: { status: "SUCCEEDED" },
        });
        if (claim.count === 1) {
          await tx.organizationSubscription.update({
            where: { organizationId: checkoutSession.organizationId },
            data: {
              plan: checkoutSession.targetPlanId,
              status: nextStatus ?? "ACTIVE",
              externalCustomerId: currentSubscription.externalCustomerId ?? event.customerId,
              externalSubscriptionId: currentSubscription.externalSubscriptionId ?? event.subscriptionId,
            },
          });
          statusChanged = true;
          await recordActivityEvent(tx, {
            organizationId: checkoutSession.organizationId,
            type: "SUBSCRIPTION_STATUS_CHANGED",
            summary: `Checkout completed: plan changed from ${currentSubscription.plan} to ${checkoutSession.targetPlanId} (${event.eventIdentity.provider} payment)`,
            metadata: {
              provider: event.eventIdentity.provider,
              eventId: event.eventIdentity.eventId,
              checkoutSessionId: checkoutSession.id,
              previousPlan: currentSubscription.plan,
              plan: checkoutSession.targetPlanId,
              previousStatus: currentSubscription.status,
              status: nextStatus ?? "ACTIVE",
              ...(event.amountMinor !== undefined ? { amountMinor: event.amountMinor.toString() } : {}),
              ...(event.currency !== undefined ? { currency: event.currency } : {}),
            },
          });
        }
      } else if (checkoutOutcome === "FAILED" || amountMismatch) {
        // Only the checkout session fails — the organization's existing
        // subscription (if any) is never touched. See
        // `checkoutOutcomeFromStatus`'s doc comment. A mismatched amount
        // on an otherwise-"succeeded" event lands here too, via the
        // `amountMismatch` guard above.
        await tx.billingCheckoutSession.updateMany({
          where: { id: checkoutSession.id, status: "PENDING" },
          data: { status: "FAILED" },
        });
      }
      // checkoutOutcome === "PENDING" (e.g. YooKassa's waiting_for_capture):
      // the ledger row above is the only durable record so far; neither the
      // checkout session nor the subscription changes state yet.

      return { outcome: "applied" as const, organizationId: checkoutSession.organizationId, statusChanged };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
      return { outcome: "duplicate", organizationId: checkoutSession.organizationId };
    }
    throw error;
  }
}

/**
 * The pre-Phase-20 path, unchanged in behavior: organization resolution is
 * by `externalCustomerId`/`externalSubscriptionId` match, scoped to
 * `event.eventIdentity.provider` — an org whose billing was never linked
 * to this event's customer/subscription id resolves to
 * "unknown_organization" rather than a lookup by any other means, so no
 * other organization's subscription can ever be mutated by a webhook it
 * didn't originate from.
 *
 * Never touches `plan` — only `status` (see mapNormalizedStatus). Mapping
 * a vendor's raw `planId` to a PAYNORA `PlanId` requires real pricing to
 * exist first; for this path, plan changes stay exactly where they were
 * before Phase 20 — `setOrganizationPlan`, called by a human/admin action.
 *
 * `customerId`/`subscriptionId` are optional as of Phase 20 (a
 * payment-based provider like YooKassa's checkout flow has neither) — if
 * an event carries neither (and also carries no `paymentId`, or it would
 * have gone through `applyCheckoutDrivenEvent` instead), there is nothing
 * to resolve an organization by, so this returns "unknown_organization"
 * immediately rather than querying with an unconstrained `OR: []`, which
 * some ORMs (Prisma included) would otherwise treat as "no filter at all"
 * — a real risk of matching an arbitrary organization's subscription.
 */
async function applyLegacyLinkedEvent(
  event: NormalizedSubscriptionEvent,
): Promise<ApplySubscriptionWebhookEventResult> {
  const provider = event.eventIdentity.provider;

  const orConditions: Prisma.OrganizationSubscriptionWhereInput[] = [];
  if (event.customerId) orConditions.push({ externalCustomerId: event.customerId });
  if (event.subscriptionId) orConditions.push({ externalSubscriptionId: event.subscriptionId });
  if (orConditions.length === 0) {
    return { outcome: "unknown_organization" };
  }

  const subscription = await prisma.organizationSubscription.findFirst({
    where: {
      billingProvider: provider,
      OR: orConditions,
    },
    select: { organizationId: true, status: true, externalCustomerId: true, externalSubscriptionId: true },
  });

  if (!subscription) {
    return { outcome: "unknown_organization" };
  }

  const nextStatus = mapNormalizedStatus(event.status);
  const willChangeStatus = nextStatus !== null && nextStatus !== subscription.status;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.subscriptionPayment.create({
        data: {
          organizationId: subscription.organizationId,
          provider,
          externalEventId: event.eventIdentity.eventId,
          amountMinor: event.amountMinor ?? null,
          currency: event.currency ?? null,
          status: nextStatus ?? subscription.status,
          planIdRaw: event.planId ?? null,
        },
      });

      if (willChangeStatus) {
        await tx.organizationSubscription.update({
          where: { organizationId: subscription.organizationId },
          data: {
            status: nextStatus,
            externalCustomerId: subscription.externalCustomerId ?? event.customerId,
            externalSubscriptionId: subscription.externalSubscriptionId ?? event.subscriptionId,
          },
        });

        await recordActivityEvent(tx, {
          organizationId: subscription.organizationId,
          type: "SUBSCRIPTION_STATUS_CHANGED",
          summary: `Subscription status changed from ${subscription.status} to ${nextStatus} (${provider} webhook)`,
          metadata: {
            provider,
            eventId: event.eventIdentity.eventId,
            previousStatus: subscription.status,
            status: nextStatus,
            ...(event.amountMinor !== undefined ? { amountMinor: event.amountMinor.toString() } : {}),
            ...(event.currency !== undefined ? { currency: event.currency } : {}),
          },
        });
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
      return { outcome: "duplicate", organizationId: subscription.organizationId };
    }
    throw error;
  }

  return { outcome: "applied", organizationId: subscription.organizationId, statusChanged: willChangeStatus };
}
