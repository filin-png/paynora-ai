import type { PlanId, SubscriptionStatus } from "@prisma/client";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PlanComparison } from "@/components/billing/plan-comparison";
import { cn } from "@/lib/utils";
import type { EntitlementLimit } from "@/server/billing/plans";
import {
  getAiGenerationUsage,
  getOrganizationEntitlements,
  getOrganizationUsage,
} from "@/server/billing/entitlements";

export const PLAN_LABEL: Record<PlanId, string> = {
  FREE: "Free",
  STARTER: "Starter",
  PRO: "Pro",
};

const STATUS_DISPLAY: Record<SubscriptionStatus, { label: string; tone: NonNullable<BadgeProps["tone"]> }> = {
  ACTIVE: { label: "Active", tone: "success" },
  TRIALING: { label: "Trialing", tone: "info" },
  PAST_DUE: { label: "Past due", tone: "warning" },
  CANCELED: { label: "Canceled", tone: "neutral" },
};

function formatLimit(limit: EntitlementLimit): string {
  return limit.kind === "unlimited" ? "Unlimited" : String(limit.max);
}

/**
 * The plan/usage view (Phase 11.3 brief, section 11) — real numbers from
 * the same entitlement layer every enforcement point reads
 * (src/server/billing/entitlements.ts), never a mockup. Deliberately no
 * "Upgrade" button or payment form: there is no checkout in this phase
 * (section 16), and a button that leads nowhere would be worse than no
 * button at all.
 */
export async function BillingTab({ organizationId }: { organizationId: string }) {
  const [{ plan, status, entitlements }, usage, aiUsage] = await Promise.all([
    getOrganizationEntitlements(organizationId),
    getOrganizationUsage(organizationId),
    getAiGenerationUsage(organizationId),
  ]);
  const statusDisplay = STATUS_DISPLAY[status];

  const usageRows: { label: string; used: number; limit: EntitlementLimit }[] = [
    { label: "Customers", used: usage.customers, limit: entitlements.maxCustomers },
    { label: "Open invoices", used: usage.openInvoices, limit: entitlements.maxOpenInvoices },
    { label: "Members", used: usage.members, limit: entitlements.maxMembers },
    { label: "AI generations (30 days)", used: aiUsage.used, limit: aiUsage.limit },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex items-center justify-between p-6">
        <div>
          <p className="text-sm text-muted">Current plan</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{PLAN_LABEL[plan]}</p>
        </div>
        <Badge tone={statusDisplay.tone}>{statusDisplay.label}</Badge>
      </Card>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Usage</p>
        <Card className="flex flex-col divide-y divide-border p-0">
          {usageRows.map((row) => (
            <UsageRow key={row.label} {...row} />
          ))}
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Capabilities</p>
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            <li className="flex items-center justify-between px-5 py-3.5 text-sm">
              <span className="text-foreground">Collections Automation</span>
              <Badge tone={entitlements.collectionsAutomationEnabled ? "success" : "neutral"}>
                {entitlements.collectionsAutomationEnabled ? "Available" : "Not available on this plan"}
              </Badge>
            </li>
          </ul>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Compare plans</p>
        <PlanComparison currentPlan={plan} />
      </div>

      <p className="text-xs text-muted">
        Online billing is not connected yet — plans are currently managed by PAYNORA directly, and no payment method
        is required. Contact PAYNORA to change your plan.
      </p>
    </div>
  );
}

function UsageRow({ label, used, limit }: { label: string; used: number; limit: EntitlementLimit }) {
  const percent = limit.kind === "unlimited" ? 0 : Math.min(100, limit.max === 0 ? 100 : (used / limit.max) * 100);
  const overLimit = limit.kind === "limited" && used >= limit.max;

  return (
    <div className="px-5 py-3.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-foreground">{label}</span>
        <span className={cn("tabular-nums", overLimit ? "font-medium text-danger" : "text-muted-foreground")}>
          {used} / {formatLimit(limit)}
        </span>
      </div>
      {limit.kind === "limited" ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-accent-soft">
          <div
            className={cn("h-full rounded-full", overLimit ? "bg-danger" : "bg-primary")}
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
