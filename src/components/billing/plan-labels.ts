import type { PlanId } from "@prisma/client";

import type { EntitlementLimit } from "@/server/billing/plans";

/**
 * The one place plan display copy lives — labels and marketing blurbs are
 * presentation, not domain data (the actual entitlement numbers/prices
 * stay in src/server/billing/plans.ts's `PLAN_ENTITLEMENTS`, the single
 * source of truth every one of these UI surfaces reads from). Shared by
 * the landing page's plans section (src/app/page.tsx), the in-app
 * Settings -> Billing comparison (plan-comparison.tsx), and the Billing
 * tab itself — previously three separate copies of the same four labels,
 * which is exactly the "не хардкодить цены по всему приложению" duplication
 * this phase's brief asks not to repeat.
 */
export const PLAN_LABEL: Record<PlanId, string> = {
  FREE: "Free",
  STARTER: "Starter",
  BUSINESS: "Business",
  PRO: "Pro",
};

export const PLAN_BLURB: Record<PlanId, string> = {
  FREE: "Get started with a small, focused book of business.",
  STARTER: "For growing teams that want automated follow-up and a Copilot.",
  BUSINESS: "For teams that need higher limits, Wallet, and Copilot together.",
  PRO: "For teams that need the highest limits and the most seats.",
};

export function formatPlanLimit(limit: EntitlementLimit): string {
  return limit.kind === "unlimited" ? "Unlimited" : String(limit.max);
}
