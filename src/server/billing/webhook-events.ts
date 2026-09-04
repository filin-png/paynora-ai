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
 * Applies one verified, normalized billing webhook event to durable
 * state. This is the layer `docs/provider-strategy.md#billingprovider`
 * describes as "future domain logic, not this layer's job" for
 * BillingProvider itself — deliberately callable today with a
 * hand-constructed `NormalizedSubscriptionEvent`, before any real vendor
 * adapter exists, so this half of the pipeline is real and tested ahead
 * of the vendor decision (see src/app/api/webhooks/billing/route.ts,
 * which will call this once a real adapter produces real events).
 *
 * Never touches `plan` — only `status` (see mapNormalizedStatus). Mapping
 * a vendor's raw `planId` to a PAYNORA `PlanId` requires real pricing to
 * exist first (src/server/billing/plans.ts's own "do not make arbitrary
 * pricing decisions" constraint); until then, plan changes stay exactly
 * where they are today — `setOrganizationPlan`, called by a human/admin
 * action.
 *
 * Idempotent on `(provider, eventId)`: providers retry webhook delivery,
 * so the same event can arrive more than once. Every event is recorded
 * once in `SubscriptionPayment` (the audit trail — see that model's doc
 * comment) via the unique constraint doing the real dedup work, not a
 * check-then-insert race. Organization resolution is by
 * `externalCustomerId`/`externalSubscriptionId` match, scoped to
 * `event.eventIdentity.provider` — an org whose billing was never linked
 * to this event's customer/subscription id (e.g. before checkout-linking
 * exists) resolves to "unknown_organization" rather than a lookup by any
 * other means, so no other organization's subscription can ever be
 * mutated by a webhook it didn't originate from.
 */
export async function applySubscriptionWebhookEvent(
  event: NormalizedSubscriptionEvent,
): Promise<ApplySubscriptionWebhookEventResult> {
  const provider = event.eventIdentity.provider;

  const subscription = await prisma.organizationSubscription.findFirst({
    where: {
      billingProvider: provider,
      OR: [{ externalCustomerId: event.customerId }, { externalSubscriptionId: event.subscriptionId }],
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
