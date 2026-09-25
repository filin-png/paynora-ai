import type { SubscriptionStatus } from "@prisma/client";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmActionButton } from "@/components/ui/confirm-action-button";
import { EmptyState } from "@/components/ui/empty-state";
import { PlanComparison } from "@/components/billing/plan-comparison";
import { formatPlanLimit, PLAN_LABEL } from "@/components/billing/plan-labels";
import { getDictionary, type Dictionary } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
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

function statusDisplayMap(t: Dictionary["settingsBilling"]): Record<SubscriptionStatus, { label: string; tone: NonNullable<BadgeProps["tone"]> }> {
  return {
    ACTIVE: { label: t.statusActive, tone: "success" },
    TRIALING: { label: t.statusTrialing, tone: "info" },
    PAST_DUE: { label: t.statusPastDue, tone: "warning" },
    CANCELED: { label: t.statusCanceled, tone: "neutral" },
    EXPIRED: { label: t.statusTrialExpired, tone: "neutral" },
  };
}

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
  const t = getDictionary(await getLocale()).settingsBilling;
  const [overview, payments, latestCheckout] = await Promise.all([
    getOrganizationUsageOverview(organizationId),
    getOrganizationSubscriptionPayments(organizationId),
    getLatestCheckoutSession(organizationId),
  ]);
  const { plan, effectiveStatus, entitlements, billingPeriod, resourceUsage, aiGenerationUsage, copilotUsageCount } =
    overview;
  const statusDisplay = statusDisplayMap(t)[effectiveStatus];
  const isOwner = role === "OWNER";
  const billingConnected = isBillingEnabled();

  const usageRows: { label: string; used: number; limit: EntitlementLimit }[] = [
    { label: t.usageCustomers, used: resourceUsage.customers, limit: entitlements.maxCustomers },
    { label: t.usageOpenInvoices, used: resourceUsage.openInvoices, limit: entitlements.maxOpenInvoices },
    { label: t.usageMembers, used: resourceUsage.members, limit: entitlements.maxMembers },
    { label: t.usageAiGenerations, used: aiGenerationUsage.used, limit: aiGenerationUsage.limit },
  ];

  const otherPlans = PLAN_ORDER.filter((candidate) => candidate !== plan);
  const checkoutInProgress = latestCheckout?.status === "PENDING" && !latestCheckout.isStale ? latestCheckout : null;

  return (
    <div className="flex flex-col gap-6">
      {checkoutInProgress ? (
        <Card className="flex flex-col gap-3 border-primary/30 bg-accent-soft p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              {t.paymentPendingUpgrade.replace("{plan}", PLAN_LABEL[checkoutInProgress.targetPlanId])}
            </p>
            <p className="mt-1 text-xs text-muted">
              {t.waitingForConfirmation.replace(
                "{amount}",
                formatMoney(checkoutInProgress.amountMinor, checkoutInProgress.currency as Parameters<typeof formatMoney>[1]),
              )}
            </p>
          </div>
          {checkoutInProgress.checkoutUrl ? (
            <a
              href={checkoutInProgress.checkoutUrl}
              className={cn(buttonVariants({ variant: "primary", size: "sm" }))}
            >
              {t.resumePayment}
            </a>
          ) : null}
        </Card>
      ) : null}

      <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-muted">{t.currentPlan}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{PLAN_LABEL[plan]}</p>
          <p className="mt-1 text-sm text-muted">
            {entitlements.priceMinor === 0n
              ? t.free
              : t.priceMonthly.replace("{amount}", formatMoney(entitlements.priceMinor, entitlements.currency))}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <Badge tone={statusDisplay.tone}>{statusDisplay.label}</Badge>
          <p className="text-xs text-muted">
            {t.billingPeriod
              .replace("{start}", formatDateTime(billingPeriod.start))
              .replace("{end}", formatDateTime(billingPeriod.end))}
            {billingPeriod.source === "derived" ? t.estimatedSuffix : ""}
          </p>
        </div>
      </Card>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t.usage}</p>
        <Card className="flex flex-col divide-y divide-border p-0">
          {usageRows.map((row) => (
            <UsageRow key={row.label} {...row} />
          ))}
          <div className="px-5 py-3.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground">{t.copilotRequests}</span>
              <span className="tabular-nums text-muted-foreground">{copilotUsageCount}</span>
            </div>
            <p className="mt-1 text-xs text-muted">{t.meteredForVisibility}</p>
          </div>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t.capabilities}</p>
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            <CapabilityRow label={t.collectionsAutomation} enabled={entitlements.collectionsAutomationEnabled} t={t} />
            <CapabilityRow label={t.proactiveCopilot} enabled={entitlements.copilotEnabled} t={t} />
            <CapabilityRow label={t.wallet} enabled={entitlements.walletEnabled} t={t} />
            <CapabilityRow label={t.integrations} enabled={entitlements.integrationsEnabled} t={t} />
          </ul>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t.subscriptionPayments}</p>
        <Card className="overflow-hidden p-0">
          {payments.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2.5 font-medium">{t.columnDate}</th>
                    <th className="px-5 py-2.5 font-medium">{t.columnProvider}</th>
                    <th className="px-5 py-2.5 font-medium">{t.columnStatus}</th>
                    <th className="px-5 py-2.5 font-medium">{t.columnAmount}</th>
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
              title={t.noPaymentsTitle}
              description={billingConnected ? t.noPaymentsDescriptionConnected : t.noPaymentsDescriptionNotConnected}
            />
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t.comparePlans}</p>
        <PlanComparison currentPlan={plan} />
      </div>

      {isOwner ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t.changePlan}</p>
          <Card className="flex flex-col gap-3 p-6">
            {effectiveStatus === "CANCELED" ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-foreground">{t.subscriptionCanceledNotice.replace("{plan}", PLAN_LABEL[plan])}</p>
                <form action={reactivateSubscriptionAction.bind(null, orgSlug)}>
                  <button type="submit" className={cn(buttonVariants({ variant: "primary", size: "sm" }))}>
                    {t.reactivate}
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
                          ? t.free
                          : t.priceMonthly.replace(
                              "{amount}",
                              formatMoney(candidateEntitlements.priceMinor, candidateEntitlements.currency),
                            )}
                      </span>
                      {isDowngrade ? (
                        <ConfirmActionButton
                          trigger={
                            <button type="button" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                              {t.downgrade}
                            </button>
                          }
                          action={downgradePlanAction.bind(null, orgSlug, candidate)}
                          confirmTitle={t.downgradeConfirmTitle.replace("{plan}", PLAN_LABEL[candidate])}
                          confirmDescription={t.downgradeConfirmDescription}
                          confirmLabel={t.downgrade}
                        />
                      ) : billingConnected ? (
                        checkoutInProgress ? (
                          <span className="text-xs text-muted">{t.checkoutInProgress}</span>
                        ) : (
                          <form action={startUpgradeCheckoutAction.bind(null, orgSlug, candidate)}>
                            <button type="submit" className={cn(buttonVariants({ variant: "primary", size: "sm" }))}>
                              {t.upgrade}
                            </button>
                          </form>
                        )
                      ) : (
                        <span className="text-xs text-muted">{t.paymentNotConnectedYet}</span>
                      )}
                    </div>
                  );
                })}
                {plan !== "FREE" ? (
                  <div className="mt-2 border-t border-border pt-3">
                    <ConfirmActionButton
                      trigger={
                        <button type="button" className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}>
                          {t.cancelSubscription}
                        </button>
                      }
                      action={cancelSubscriptionAction.bind(null, orgSlug)}
                      confirmTitle={t.cancelConfirmTitle}
                      confirmDescription={t.cancelConfirmDescription}
                      confirmLabel={t.cancelSubscription}
                    />
                  </div>
                ) : null}
              </>
            )}
          </Card>
        </div>
      ) : null}

      <p className="text-xs text-muted">{billingConnected ? t.billingConnectedNote : t.billingNotConnectedNote}</p>
    </div>
  );
}

function CapabilityRow({ label, enabled, t }: { label: string; enabled: boolean; t: Dictionary["settingsBilling"] }) {
  return (
    <li className="flex items-center justify-between px-5 py-3.5 text-sm">
      <span className="text-foreground">{label}</span>
      <Badge tone={enabled ? "success" : "neutral"}>{enabled ? t.available : t.notAvailableOnPlan}</Badge>
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
