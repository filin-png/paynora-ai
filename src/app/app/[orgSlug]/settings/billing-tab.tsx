import type { SubscriptionStatus } from "@prisma/client";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmActionButton } from "@/components/ui/confirm-action-button";
import { EmptyState } from "@/components/ui/empty-state";
import { PlanComparison } from "@/components/billing/plan-comparison";
import { formatPlanLimit, PLAN_LABEL } from "@/components/billing/plan-labels";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/server/ar/money";
import { getLatestCheckoutSession } from "@/server/billing/checkout";
import type { EntitlementLimit } from "@/server/billing/plans";
import { PLAN_ENTITLEMENTS, PLAN_ORDER, planRank } from "@/server/billing/plans";
import { getOrganizationUsageOverview } from "@/server/billing/entitlements";
import { getOrganizationSubscriptionPayments } from "@/server/billing/payment-history";
import { isBillingEnabled } from "@/server/billing/service";
import {
  cancelSubscriptionAction,
  downgradePlanAction,
  reactivateSubscriptionAction,
  startUpgradeCheckoutAction,
} from "./billing-actions";

const STATUS_DISPLAY: Record<SubscriptionStatus, { label: string; tone: NonNullable<BadgeProps["tone"]> }> = {
  ACTIVE: { label: "Active", tone: "success" },
  TRIALING: { label: "Trialing", tone: "info" },
  PAST_DUE: { label: "Past due", tone: "warning" },
  CANCELED: { label: "Canceled", tone: "neutral" },
  EXPIRED: { label: "Trial expired", tone: "neutral" },
};

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}

/**
 * The plan/usage/billing view (Phase 11.3 brief section 11, extended by
 * Phase 19) — real numbers from the same entitlement layer every
 * enforcement point reads (src/server/billing/entitlements.ts), never a
 * mockup. `role` gates the mutating actions below (cancel/reactivate/
 * downgrade) — every member can still see this tab, only an OWNER gets
 * the action buttons, matching requireOrganizationRoleForPage's own
 * server-side gate in billing-actions.ts (the UI gate here is a
 * convenience, not the actual enforcement boundary).
 */
export async function BillingTab({
  organizationId,
  orgSlug,
  role,
}: {
  organizationId: string;
  orgSlug: string;
  role: string;
}) {
  const [overview, payments, latestCheckout] = await Promise.all([
    getOrganizationUsageOverview(organizationId),
    getOrganizationSubscriptionPayments(organizationId),
    getLatestCheckoutSession(organizationId),
  ]);
  const { plan, effectiveStatus, entitlements, billingPeriod, resourceUsage, aiGenerationUsage, copilotUsageCount } =
    overview;
  const statusDisplay = STATUS_DISPLAY[effectiveStatus];
  const isOwner = role === "OWNER";
  const billingConnected = isBillingEnabled();

  const usageRows: { label: string; used: number; limit: EntitlementLimit }[] = [
    { label: "Customers", used: resourceUsage.customers, limit: entitlements.maxCustomers },
    { label: "Open invoices", used: resourceUsage.openInvoices, limit: entitlements.maxOpenInvoices },
    { label: "Members", used: resourceUsage.members, limit: entitlements.maxMembers },
    { label: "AI generations (30 days)", used: aiGenerationUsage.used, limit: aiGenerationUsage.limit },
  ];

  const otherPlans = PLAN_ORDER.filter((candidate) => candidate !== plan);
  const checkoutInProgress = latestCheckout?.status === "PENDING" && !latestCheckout.isStale ? latestCheckout : null;

  return (
    <div className="flex flex-col gap-6">
      {checkoutInProgress ? (
        <Card className="flex flex-col gap-3 border-primary/30 bg-accent-soft p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              Payment pending — upgrade to {PLAN_LABEL[checkoutInProgress.targetPlanId]}
            </p>
            <p className="mt-1 text-xs text-muted">
              {formatMoney(checkoutInProgress.amountMinor, checkoutInProgress.currency as Parameters<typeof formatMoney>[1])}{" "}
              — waiting for payment confirmation. This updates automatically once the provider confirms it.
            </p>
          </div>
          {checkoutInProgress.checkoutUrl ? (
            <a
              href={checkoutInProgress.checkoutUrl}
              className={cn(buttonVariants({ variant: "primary", size: "sm" }))}
            >
              Resume payment
            </a>
          ) : null}
        </Card>
      ) : null}

      <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-muted">Current plan</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{PLAN_LABEL[plan]}</p>
          <p className="mt-1 text-sm text-muted">
            {entitlements.priceMinor === 0n
              ? "Free"
              : `${formatMoney(entitlements.priceMinor, entitlements.currency)}/mo`}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <Badge tone={statusDisplay.tone}>{statusDisplay.label}</Badge>
          <p className="text-xs text-muted">
            Billing period: {formatDateTime(billingPeriod.start)} – {formatDateTime(billingPeriod.end)}
            {billingPeriod.source === "derived" ? " (estimated)" : ""}
          </p>
        </div>
      </Card>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Usage</p>
        <Card className="flex flex-col divide-y divide-border p-0">
          {usageRows.map((row) => (
            <UsageRow key={row.label} {...row} />
          ))}
          <div className="px-5 py-3.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground">Copilot requests (30 days)</span>
              <span className="tabular-nums text-muted-foreground">{copilotUsageCount}</span>
            </div>
            <p className="mt-1 text-xs text-muted">Metered for visibility only — not a separate limit.</p>
          </div>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Capabilities</p>
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            <CapabilityRow label="Collections Automation" enabled={entitlements.collectionsAutomationEnabled} />
            <CapabilityRow label="Proactive Copilot" enabled={entitlements.copilotEnabled} />
            <CapabilityRow label="Wallet" enabled={entitlements.walletEnabled} />
            <CapabilityRow label="Integrations" enabled={entitlements.integrationsEnabled} />
          </ul>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Subscription payments</p>
        <Card className="overflow-hidden p-0">
          {payments.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2.5 font-medium">Date</th>
                    <th className="px-5 py-2.5 font-medium">Provider</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                    <th className="px-5 py-2.5 font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {payments.map((payment) => (
                    <tr key={payment.id}>
                      <td className="px-5 py-3 text-foreground">{formatDateTime(payment.receivedAt)}</td>
                      <td className="px-5 py-3 text-muted-foreground">{payment.provider}</td>
                      <td className="px-5 py-3 text-muted-foreground">{payment.status}</td>
                      <td className="px-5 py-3 tabular-nums text-foreground">
                        {payment.amountMinor !== null && payment.currency
                          ? formatMoney(payment.amountMinor, payment.currency as Parameters<typeof formatMoney>[1])
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No subscription payments yet"
              description={
                billingConnected
                  ? "No billing webhook deliveries have been recorded for this organization yet."
                  : "Online payment isn't connected yet for this deployment — there is nothing to show here until it is."
              }
            />
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Compare plans</p>
        <PlanComparison currentPlan={plan} />
      </div>

      {isOwner ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Change plan</p>
          <Card className="flex flex-col gap-3 p-6">
            {effectiveStatus === "CANCELED" ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-foreground">
                  This subscription is canceled. Reactivating restores {PLAN_LABEL[plan]} immediately — no payment
                  step, since none is connected yet.
                </p>
                <form action={reactivateSubscriptionAction.bind(null, orgSlug)}>
                  <button type="submit" className={cn(buttonVariants({ variant: "primary", size: "sm" }))}>
                    Reactivate
                  </button>
                </form>
              </div>
            ) : (
              <>
                {otherPlans.map((candidate) => {
                  const isDowngrade = planRank(candidate) < planRank(plan);
                  const candidateEntitlements = PLAN_ENTITLEMENTS[candidate];
                  return (
                    <div key={candidate} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-foreground">
                        {PLAN_LABEL[candidate]} —{" "}
                        {candidateEntitlements.priceMinor === 0n
                          ? "Free"
                          : `${formatMoney(candidateEntitlements.priceMinor, candidateEntitlements.currency)}/mo`}
                      </span>
                      {isDowngrade ? (
                        <ConfirmActionButton
                          trigger={
                            <button type="button" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                              Downgrade
                            </button>
                          }
                          action={downgradePlanAction.bind(null, orgSlug, candidate)}
                          confirmTitle={`Downgrade to ${PLAN_LABEL[candidate]}?`}
                          confirmDescription="Existing customers, invoices, and members are never removed — only new quota-consuming creation is bounded by the new plan's limits from now on."
                          confirmLabel="Downgrade"
                        />
                      ) : billingConnected ? (
                        checkoutInProgress ? (
                          <span className="text-xs text-muted">Checkout already in progress</span>
                        ) : (
                          <form action={startUpgradeCheckoutAction.bind(null, orgSlug, candidate)}>
                            <button type="submit" className={cn(buttonVariants({ variant: "primary", size: "sm" }))}>
                              Upgrade
                            </button>
                          </form>
                        )
                      ) : (
                        <span className="text-xs text-muted">Payment not connected yet</span>
                      )}
                    </div>
                  );
                })}
                {plan !== "FREE" ? (
                  <div className="mt-2 border-t border-border pt-3">
                    <ConfirmActionButton
                      trigger={
                        <button type="button" className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}>
                          Cancel subscription
                        </button>
                      }
                      action={cancelSubscriptionAction.bind(null, orgSlug)}
                      confirmTitle="Cancel this subscription?"
                      confirmDescription="Immediately reverts to Free-plan limits. Data is never deleted — reactivating later restores this exact plan, with no payment step, since none is connected yet."
                      confirmLabel="Cancel subscription"
                    />
                  </div>
                ) : null}
              </>
            )}
          </Card>
        </div>
      ) : null}

      <p className="text-xs text-muted">
        {billingConnected
          ? "A real payment provider is connected for this deployment."
          : "Online payment is not connected yet — upgrades are handled by PAYNORA directly. Downgrades and cancellation are self-serve and take effect immediately."}
      </p>
    </div>
  );
}

function CapabilityRow({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <li className="flex items-center justify-between px-5 py-3.5 text-sm">
      <span className="text-foreground">{label}</span>
      <Badge tone={enabled ? "success" : "neutral"}>{enabled ? "Available" : "Not available on this plan"}</Badge>
    </li>
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
          {used} / {formatPlanLimit(limit)}
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
