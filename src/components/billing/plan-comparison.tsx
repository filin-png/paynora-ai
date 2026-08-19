import type { PlanId } from "@prisma/client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PLAN_ENTITLEMENTS, type EntitlementLimit } from "@/server/billing/plans";

const PLAN_ORDER: PlanId[] = ["FREE", "STARTER", "PRO"];

const PLAN_LABEL: Record<PlanId, string> = { FREE: "Free", STARTER: "Starter", PRO: "Pro" };

const PLAN_BLURB: Record<PlanId, string> = {
  FREE: "Get started with a small, focused book of business.",
  STARTER: "For growing teams that want automated follow-up.",
  PRO: "For teams that need higher limits and more seats.",
};

function formatLimit(limit: EntitlementLimit): string {
  return limit.kind === "unlimited" ? "Unlimited" : String(limit.max);
}

/**
 * Reads `PLAN_ENTITLEMENTS` (src/server/billing/plans.ts) directly — the
 * one authoritative plan catalog every enforcement point in the app already
 * reads (Phase 11.4 brief, section 5: "do not duplicate plan limits as
 * unrelated hardcoded UI values"). Used both in Settings → Billing (with
 * `currentPlan` set) and on the public landing page (without it).
 */
export function PlanComparison({ currentPlan }: { currentPlan?: PlanId }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {PLAN_ORDER.map((planId) => {
        const entitlements = PLAN_ENTITLEMENTS[planId];
        const isCurrent = currentPlan === planId;
        return (
          <Card key={planId} className={cn("flex flex-col gap-4 p-6", isCurrent && "ring-2 ring-primary")}>
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-foreground">{PLAN_LABEL[planId]}</p>
                {isCurrent ? <Badge tone="info">Current plan</Badge> : null}
              </div>
              <p className="mt-1 text-xs text-muted">{PLAN_BLURB[planId]}</p>
            </div>
            <ul className="flex flex-col gap-2 text-sm text-foreground">
              <li>{formatLimit(entitlements.maxCustomers)} customers</li>
              <li>{formatLimit(entitlements.maxOpenInvoices)} open invoices</li>
              <li>{formatLimit(entitlements.maxMembers)} team members</li>
              <li>{formatLimit(entitlements.maxAiGenerationsPerMonth)} AI generations / month</li>
              <li className={entitlements.collectionsAutomationEnabled ? undefined : "text-muted-foreground"}>
                {entitlements.collectionsAutomationEnabled ? "Collections automation" : "No collections automation"}
              </li>
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
