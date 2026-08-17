import type { PlanId, SubscriptionStatus } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";

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
