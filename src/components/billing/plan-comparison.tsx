import type { PlanId } from "@prisma/client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/server/ar/money";
import { PLAN_ENTITLEMENTS, PLAN_ORDER } from "@/server/billing/plans";
import { formatPlanLimit, PLAN_BLURB, PLAN_LABEL } from "./plan-labels";

function formatPlanPrice(priceMinor: bigint, currency: Parameters<typeof formatMoney>[1]): string {
  return priceMinor === 0n ? "Free" : `${formatMoney(priceMinor, currency)}/mo`;
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
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
              <p className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                {formatPlanPrice(entitlements.priceMinor, entitlements.currency)}
              </p>
              <p className="mt-1 text-xs text-muted">{PLAN_BLURB[planId]}</p>
            </div>
            <ul className="flex flex-col gap-2 text-sm text-foreground">
              <li>{formatPlanLimit(entitlements.maxCustomers)} customers</li>
              <li>{formatPlanLimit(entitlements.maxOpenInvoices)} open invoices</li>
              <li>{formatPlanLimit(entitlements.maxMembers)} team members</li>
              <li>{formatPlanLimit(entitlements.maxAiGenerationsPerMonth)} AI generations / month</li>
              <li className={entitlements.collectionsAutomationEnabled ? undefined : "text-muted-foreground"}>
                {entitlements.collectionsAutomationEnabled ? "Collections automation" : "No collections automation"}
              </li>
              <li className={entitlements.copilotEnabled ? undefined : "text-muted-foreground"}>
                {entitlements.copilotEnabled ? "Proactive Copilot" : "No Copilot"}
              </li>
              <li className={entitlements.walletEnabled ? undefined : "text-muted-foreground"}>
                {entitlements.walletEnabled ? "Wallet" : "No Wallet"}
              </li>
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
