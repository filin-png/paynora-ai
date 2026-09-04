import type { PlanId, SubscriptionStatus } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";
import { planRank } from "./plans";

/**
 * The one place PAYNORA's own subscription state is actually written.
 * There is no checkout or payment webhook in this phase (section 16) — a
 * plan change today only ever happens through this function, called from
 * a test fixture or a future admin tool. This is deliberately the exact
 * shape a future billing adapter would call too: "apply this normalized
 * plan/status change", with no knowledge of which vendor (or human)
 * decided it — see src/server/billing/types.ts's
 * `NormalizedSubscriptionEvent` for the webhook-side equivalent this is
 * designed to slot underneath later, and section 10's "AR/AI/Collections
 * code must not know whether YooKassa, Stripe, manual billing, or another
 * provider caused the subscription change."
 *
 * Upgrade behavior (section 9) requires no special code: the new plan's
 * entitlements simply apply to the very next `getOrganizationEntitlements`
 * call, since nothing is cached. Downgrade behavior likewise requires no
 * special code here — existing customer/invoice/member rows are never
 * touched by a plan change; `assertWithinResourceLimit` (entitlements.ts)
 * is what blocks *new* quota-consuming creation once usage exceeds the new
 * limit, the next time such creation is attempted.
 */
export async function setOrganizationPlan(
  organizationId: string,
  plan: PlanId,
  status: SubscriptionStatus = "ACTIVE",
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.organizationSubscription.findUniqueOrThrow({ where: { organizationId } });
    if (current.plan === plan && current.status === status) return;

    await tx.organizationSubscription.update({
      where: { organizationId },
      data: { plan, status },
    });

    await recordActivityEvent(tx, {
      organizationId,
      type: "PLAN_CHANGED",
      summary: `Plan changed from ${current.plan} (${current.status}) to ${plan} (${status})`,
      metadata: { previousPlan: current.plan, previousStatus: current.status, plan, status },
    });
  });
}

/**
 * Thrown by `changeOrganizationPlanSelfServe` for a genuine upgrade
 * attempt — there is no real payment step in this phase (Phase 19 brief:
 * "checkout сейчас не должен притворяться реальным платежом"), so an
 * upgrade must fail loudly rather than silently grant free access. See
 * docs/commercial-product-architecture.md#checkout.
 */
export class UpgradeRequiresPaymentError extends Error {
  constructor(public readonly targetPlan: PlanId) {
    super(
      `Upgrading to ${targetPlan} requires payment, which is not connected yet for this deployment. Contact PAYNORA to upgrade.`,
    );
    this.name = "UpgradeRequiresPaymentError";
  }
}

export class InvalidSubscriptionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSubscriptionTransitionError";
  }
}

/**
 * Self-serve plan change (Settings -> Billing, OWNER-only at the Server
 * Action layer) — safe by construction: only ever allowed to a plan whose
 * rank (plans.ts#planRank) is <= the current plan's rank, so this can
 * never grant more access than is already paid for regardless of what a
 * client sends (Phase 19 brief section 10: "не позволяй пользователю
 * получить PRO entitlement просто изменением client-side значения" — this
 * server-side rank check is the actual backstop, not any UI affordance).
 * A real upgrade has no payment step to complete yet, so it throws
 * `UpgradeRequiresPaymentError` instead of silently granting free access.
 */
export async function changeOrganizationPlanSelfServe(organizationId: string, targetPlan: PlanId): Promise<void> {
  const current = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId } });
  if (planRank(targetPlan) > planRank(current.plan)) {
    throw new UpgradeRequiresPaymentError(targetPlan);
  }
  await setOrganizationPlan(organizationId, targetPlan, "ACTIVE");
}

/**
 * Cancels — reverts effective access to FREE
 * (src/server/billing/entitlements.ts#deriveEffectivePlan) without
 * touching the stored `plan`, so a later reactivation restores exactly
 * what was canceled rather than resetting to FREE.
 */
export async function cancelOrganizationSubscription(organizationId: string): Promise<void> {
  const current = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId } });
  if (current.status === "CANCELED") return;
  await setOrganizationPlan(organizationId, current.plan, "CANCELED");
}

/**
 * Un-cancels — restores the stored plan's status to ACTIVE. Only valid
 * from CANCELED (throws `InvalidSubscriptionTransitionError` otherwise).
 * Cannot be used to reach a plan higher than the organization already
 * had: `cancelOrganizationSubscription` never touches `plan`, only
 * `status`, so this always restores the same plan rank it canceled from —
 * never an upgrade path.
 */
export async function reactivateOrganizationSubscription(organizationId: string): Promise<void> {
  const current = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId } });
  if (current.status !== "CANCELED") {
    throw new InvalidSubscriptionTransitionError("Only a canceled subscription can be reactivated.");
  }
  await setOrganizationPlan(organizationId, current.plan, "ACTIVE");
}
