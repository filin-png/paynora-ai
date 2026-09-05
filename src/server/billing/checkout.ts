import { randomUUID } from "node:crypto";

import { Prisma, type PlanId } from "@prisma/client";

import { env } from "@/lib/env";
import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";
import { PLAN_ENTITLEMENTS, planRank } from "./plans";
import { resolveBillingProvider } from "./service";
import type { BillingProvider, CreateCheckoutInput } from "./types";

/**
 * Thrown when the requested `targetPlanId` is not actually ranked above
 * the organization's current plan — this checkout flow only ever creates
 * a real payment for a genuine upgrade (see plans.ts#planRank). A
 * lateral/downgrade change has no payment to make; it goes through
 * subscription.ts#changeOrganizationPlanSelfServe instead.
 */
export class InvalidCheckoutPlanError extends Error {
  constructor(public readonly targetPlan: PlanId) {
    super(`${targetPlan} is not an upgrade from this organization's current plan`);
    this.name = "InvalidCheckoutPlanError";
  }
}

/**
 * Thrown when this organization already has a checkout in flight — a
 * concurrency guard, not a UX nicety: without it, two nearly-simultaneous
 * "Upgrade" clicks (or the same click submitted twice) could each create
 * a real vendor payment for the same upgrade. See `createCheckoutSession`'s
 * doc comment for how this is enforced (a row lock, not a check-then-act
 * race).
 */
export class CheckoutAlreadyInProgressError extends Error {
  constructor(public readonly existingCheckoutSessionId: string) {
    super(
      "A checkout for this organization is already in progress. Complete it, or wait for it to expire, before starting another.",
    );
    this.name = "CheckoutAlreadyInProgressError";
  }
}

/**
 * How long a `BillingCheckoutSession` stays PENDING before a new checkout
 * for the same organization is allowed to proceed alongside it —
 * comfortably longer than a real payer would take to complete (or
 * abandon) a checkout page, short enough that a genuinely abandoned
 * attempt doesn't block upgrades indefinitely. Computed on read (no
 * scheduler/cron touches BillingCheckoutSession rows) — a stale PENDING
 * row is simply never checked again once it ages out of this window; if
 * its vendor webhook does eventually arrive, `applyCheckoutDrivenEvent`
 * (webhook-events.ts) still applies it correctly regardless of how old it
 * is.
 */
export const STALE_PENDING_CHECKOUT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

async function lockOrganizationForUpdate(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  // Same row-locking idiom as entitlements.ts#lockOrganizationForUpdate —
  // serializes concurrent createCheckoutSession calls for one organization
  // so the "already in progress" check below can never be raced past by
  // two callers who both read "no pending session" before either commits.
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
}

export type CreatedCheckout = { checkoutSessionId: string; checkoutUrl: string };

type ReservedCheckout = {
  organizationSlug: string;
  checkoutSessionId: string;
  idempotencyKey: string;
  amountMinor: bigint;
  currency: string;
};

/**
 * The ONLY way an organization's plan can go up (Phase 20) — see
 * subscription.ts#changeOrganizationPlanSelfServe, which continues to
 * throw `UpgradeRequiresPaymentError` for any target ranked above the
 * current plan; this function is the real payment path that makes an
 * upgrade possible at all.
 *
 * Two phases, the same shape as communications/send.ts's
 * claim-then-dispatch pattern and for the same reason: a single DB
 * transaction cannot safely wrap a real network call to the vendor.
 *
 * 1. Inside one transaction, holding a row lock on the Organization
 *    (preventing a concurrent duplicate submission from racing past this
 *    check): validate the upgrade is real (rank check), reject if a
 *    non-stale checkout is already PENDING for this organization, then
 *    create the `BillingCheckoutSession` row itself — status PENDING,
 *    amount/currency from the plan catalog (never client input), a fresh
 *    idempotency key. This row is what `applySubscriptionWebhookEvent`
 *    later trusts for "this organization requested exactly this plan for
 *    exactly this amount" — see prisma/schema.prisma's
 *    BillingCheckoutSession doc comment.
 * 2. Outside the transaction, call the vendor's real checkout-creation
 *    API. On success, record the vendor's `externalPaymentId` on the
 *    session and an activity event. On failure, mark the session FAILED
 *    (best-effort) and rethrow — never leave a PENDING row behind for a
 *    checkout that was never actually created with the vendor, since that
 *    would needlessly block a retry for up to
 *    `STALE_PENDING_CHECKOUT_WINDOW_MS`.
 */
export async function createCheckoutSession(
  organizationId: string,
  targetPlanId: PlanId,
  options: {
    /**
     * Test-only dependency injection point, the same pattern as
     * communications/send.ts's `options.provider` — production code
     * always goes through `resolveBillingProvider()`, which is what
     * enforces `BILLING_PROVIDER`/credential configuration. Tests use
     * this to exercise real success/failure outcomes deterministically
     * via `createTestBillingProvider` without a real network call.
     */
    provider?: BillingProvider;
  } = {},
): Promise<CreatedCheckout> {
  // Resolved before any row is written — a disabled/misconfigured provider
  // must never create an orphan BillingCheckoutSession. Throws
  // BillingDisabledError / BillingProviderNotConfiguredError.
  const provider: BillingProvider = options.provider ?? resolveBillingProvider();

  const reserved = await prisma.$transaction(async (tx) => {
    await lockOrganizationForUpdate(tx, organizationId);

    const [organization, subscription] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { slug: true } }),
      tx.organizationSubscription.findUniqueOrThrow({ where: { organizationId } }),
    ]);

    if (planRank(targetPlanId) <= planRank(subscription.plan)) {
      throw new InvalidCheckoutPlanError(targetPlanId);
    }

    const existingPending = await tx.billingCheckoutSession.findFirst({
      where: { organizationId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
    if (existingPending && Date.now() - existingPending.createdAt.getTime() < STALE_PENDING_CHECKOUT_WINDOW_MS) {
      throw new CheckoutAlreadyInProgressError(existingPending.id);
    }

    const entitlements = PLAN_ENTITLEMENTS[targetPlanId];
    const idempotencyKey = randomUUID();
    const created = await tx.billingCheckoutSession.create({
      data: {
        organizationId,
        provider: provider.name,
        targetPlanId,
        amountMinor: entitlements.priceMinor,
        currency: entitlements.currency,
        idempotencyKey,
      },
    });

    const result: ReservedCheckout = {
      organizationSlug: organization.slug,
      checkoutSessionId: created.id,
      idempotencyKey,
      amountMinor: entitlements.priceMinor,
      currency: entitlements.currency,
    };
    return result;
  });

  const input: CreateCheckoutInput = {
    amountMinor: reserved.amountMinor,
    currency: reserved.currency,
    description: `PAYNORA ${targetPlanId} plan subscription`,
    returnUrl: `${env.APP_BASE_URL}/app/${reserved.organizationSlug}/settings?tab=billing`,
    idempotencyKey: reserved.idempotencyKey,
    metadata: { organizationId, targetPlanId, checkoutSessionId: reserved.checkoutSessionId },
  };

  try {
    const checkout = await provider.createCheckout(input);
    await prisma.$transaction(async (tx) => {
      await tx.billingCheckoutSession.update({
        where: { id: reserved.checkoutSessionId },
        data: { externalPaymentId: checkout.externalPaymentId, checkoutUrl: checkout.checkoutUrl },
      });
      await recordActivityEvent(tx, {
        organizationId,
        type: "CHECKOUT_SESSION_CREATED",
        summary: `Checkout started for upgrade to ${targetPlanId} (${provider.name})`,
        metadata: {
          targetPlanId,
          provider: provider.name,
          checkoutSessionId: reserved.checkoutSessionId,
          amountMinor: reserved.amountMinor.toString(),
          currency: reserved.currency,
        },
      });
    });
    return { checkoutSessionId: reserved.checkoutSessionId, checkoutUrl: checkout.checkoutUrl };
  } catch (error) {
    await prisma.billingCheckoutSession
      .updateMany({
        where: { id: reserved.checkoutSessionId, status: "PENDING" },
        data: { status: "FAILED" },
      })
      .catch((markFailedError: unknown) => {
        // Never mask the original vendor-call error with a failure to
        // record it — this is logged, not thrown, so the caller still
        // sees why the checkout itself failed.
        console.error(
          `[billing] failed to mark checkout session ${reserved.checkoutSessionId} as FAILED after a createCheckout error`,
          markFailedError,
        );
      });
    throw error;
  }
}

export type OrganizationCheckoutStatus = {
  id: string;
  targetPlanId: PlanId;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  checkoutUrl: string | null;
  amountMinor: bigint;
  currency: string;
  createdAt: Date;
  /** True once this PENDING session has aged past `STALE_PENDING_CHECKOUT_WINDOW_MS` — meaningless for any other status. */
  isStale: boolean;
};

/**
 * Organization-scoped read of the most recent checkout attempt — for the
 * Billing UI (Settings -> Billing) to show a clear pending/succeeded/failed
 * state and, while PENDING, a "Resume payment" link. Read-only; never used
 * to decide anything about entitlements or plan grants (that's
 * webhook-events.ts's job, from the verified webhook path only).
 */
export async function getLatestCheckoutSession(organizationId: string): Promise<OrganizationCheckoutStatus | null> {
  const session = await prisma.billingCheckoutSession.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
  if (!session) return null;
  return {
    id: session.id,
    targetPlanId: session.targetPlanId,
    status: session.status,
    checkoutUrl: session.checkoutUrl,
    amountMinor: session.amountMinor,
    currency: session.currency,
    createdAt: session.createdAt,
    isStale:
      session.status === "PENDING" &&
      Date.now() - session.createdAt.getTime() >= STALE_PENDING_CHECKOUT_WINDOW_MS,
  };
}
