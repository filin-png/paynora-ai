"use server";

import type { PlanId } from "@prisma/client";
import { revalidatePath } from "next/cache";

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
 * current plan, regardless of what `targetPlan` this is called with. This
 * action exists so a real downgrade button can call it directly; there is
 * deliberately no matching "upgrade" action — see the Billing tab's
 * checkout-placeholder section instead.
 */
export async function downgradePlanAction(orgSlug: string, targetPlan: PlanId): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await changeOrganizationPlanSelfServe(context.organization.id, targetPlan);
  revalidatePath(`/app/${orgSlug}/settings`);
}
