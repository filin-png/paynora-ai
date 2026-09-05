"use server";

import type { PlanId } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createCheckoutSession } from "@/server/billing/checkout";
import {
  cancelOrganizationSubscription,
  changeOrganizationPlanSelfServe,
  reactivateOrganizationSubscription,
} from "@/server/billing/subscription";
import { requireOrganizationRoleForPage } from "@/server/tenancy/guards";

/**
 * OWNER-only billing mutations (Settings -> Billing) — requireOrganizationRoleForPage
 * 404s a MEMBER who reaches one of these directly, the same gate every
 * other OWNER-only Settings action in this file's sibling modules already
 * uses (see demo-data-actions.ts). This is deliberately the ONLY place a
 * plan/status change can be triggered from the UI — see
 * src/server/billing/subscription.ts for why an upgrade specifically
 * cannot succeed here (no real payment step yet).
 */
export async function cancelSubscriptionAction(orgSlug: string): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await cancelOrganizationSubscription(context.organization.id);
  revalidatePath(`/app/${orgSlug}/settings`);
}

export async function reactivateSubscriptionAction(orgSlug: string): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await reactivateOrganizationSubscription(context.organization.id);
  revalidatePath(`/app/${orgSlug}/settings`);
}

/**
 * Only ever succeeds for a downgrade or lateral change — `changeOrganizationPlanSelfServe`
 * throws `UpgradeRequiresPaymentError` for anything ranked higher than the
 * current plan, regardless of what `targetPlan` this is called with. A
 * real upgrade goes through `startUpgradeCheckoutAction` below instead,
 * never this one.
 */
export async function downgradePlanAction(orgSlug: string, targetPlan: PlanId): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await changeOrganizationPlanSelfServe(context.organization.id, targetPlan);
  revalidatePath(`/app/${orgSlug}/settings`);
}

/**
 * The ONLY way an upgrade can happen (Phase 20) — creates a real
 * `BillingCheckoutSession` and a real vendor payment
 * (src/server/billing/checkout.ts#createCheckoutSession), then redirects
 * the browser straight to the vendor's checkout page. There is
 * deliberately no server action that flips `plan` directly for an
 * upgrade — see `downgradePlanAction`'s doc comment and
 * subscription.ts#changeOrganizationPlanSelfServe, which still throws
 * `UpgradeRequiresPaymentError` for any target ranked above the current
 * plan.
 *
 * Errors (billing disabled/unconfigured, not a real upgrade, a checkout
 * already in progress, a vendor-call failure) are left to throw — same
 * as every other action in this file — surfacing via the Settings page's
 * error boundary rather than a silent no-op.
 */
export async function startUpgradeCheckoutAction(orgSlug: string, targetPlan: PlanId): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  const { checkoutUrl } = await createCheckoutSession(context.organization.id, targetPlan);
  redirect(checkoutUrl);
}
