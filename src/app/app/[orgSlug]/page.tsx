import Link from "next/link";
import { AlertTriangle, ArrowRight, CalendarClock, Plus, Receipt, Sparkles, UserPlus, Zap } from "lucide-react";

import { AIInsightCard, AIInsightsPanel } from "@/components/ui/ai-insight-card";
import { AttentionScoreBadge, explainAttentionScore } from "@/components/ui/attention-score";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChartCard } from "@/components/ui/chart-card";
import { DonutChart, TrendChart } from "@/components/ui/charts";
import { EmptyState } from "@/components/ui/empty-state";
import { GlassCard } from "@/components/ui/glass-card";
import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { listOrganizationActivity } from "@/server/ar/activity";
import type { Currency } from "@/server/ar/currency";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { formatMoney } from "@/server/ar/money";
import {
  getAgingSummary,
  getInvoicesRequiringAttention,
  getOrganizationArSummary,
  getReceivablesTrend,
  listRecentPayments,
} from "@/server/ar/summary";
import { getDailyBrief, type DailyBriefAttentionItem } from "@/server/briefing/daily-brief";
import { listPendingActionProposals } from "@/server/operator/approval";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { OnboardingChecklist } from "./onboarding-checklist";

const AGING_COLORS = ["var(--warning)", "var(--primary)", "var(--secondary)", "var(--danger)"];

const ACTION_TYPE_LABEL: Record<string, string> = {
  SEND_PAYMENT_REMINDER: "Send payment reminder",
};
const PRIORITY_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const PRIORITY_TO_IMPACT: Record<string, "high" | "medium" | "low"> = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

export default async function OrganizationDashboardPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const [summary, attention, recentPayments, activity, pendingProposals, dailyBrief] = await Promise.all([
    getOrganizationArSummary(context.organization.id),
    getInvoicesRequiringAttention(context.organization.id),
    listRecentPayments(context.organization.id, 5),
    listOrganizationActivity(context.organization.id, 8),
    listPendingActionProposals(context.organization.id),
    getDailyBrief(context.organization.id),
  ]);

  const primaryCurrency: Currency | null =
    summary.length > 0
      ? summary.reduce((a, b) => (b.totalOutstandingMinor > a.totalOutstandingMinor ? b : a)).currency
      : null;

  const [trend, aging] = await Promise.all([
    primaryCurrency ? getReceivablesTrend(context.organization.id, primaryCurrency) : Promise.resolve([]),
    primaryCurrency
      ? getAgingSummary(context.organization.id, primaryCurrency)
      : Promise.resolve(null),
  ]);

  const firstPoint = trend[0];
  const lastPoint = trend[trend.length - 1];
  const totalIssuedMinor = lastPoint ? lastPoint.outstandingMinor + lastPoint.collectedMinor : 0n;
  const collectionRatePct =
    totalIssuedMinor > 0n ? Number((lastPoint!.collectedMinor * 1000n) / totalIssuedMinor) / 10 : 0;
  const recoveredWindowMinor =
    firstPoint && lastPoint ? lastPoint.collectedMinor - firstPoint.collectedMinor : 0n;
  const outstandingChangePct =
    firstPoint && lastPoint && firstPoint.outstandingMinor > 0n
      ? (Number(lastPoint.outstandingMinor - firstPoint.outstandingMinor) / Number(firstPoint.outstandingMinor)) * 100
      : undefined;

  const overdueTop = attention.filter((entry) => entry.reason === "overdue").slice(0, 6);
  const today = getBusinessToday();

  // "PAYNORA Financial Impact" (Phase 19, section 8): every number here is
  // read from data already loaded above for this same page render — no new
  // query, and deliberately no ROI/savings claim the system cannot prove.
  // See docs/commercial-product-architecture.md#value-dashboard.
  const overdueCount = attention.filter((entry) => entry.reason === "overdue").length;
  const overdueAtRiskMinor = primaryCurrency
    ? (summary.find((s) => s.currency === primaryCurrency)?.totalOverdueMinor ?? 0n)
    : 0n;
  const cashFlowRiskCount = dailyBrief.cashFlowRiskWindows.filter((w) => w.isPotentialRisk).length;

  const proposalGroups = new Map<
    string,
    { type: string; count: number; customerIds: Set<string>; priority: string }
  >();
  for (const proposal of pendingProposals) {
    const group = proposalGroups.get(proposal.type) ?? {
      type: proposal.type,
      count: 0,
      customerIds: new Set<string>(),
      priority: "LOW",
    };
    group.count += 1;
    const customerId = proposal.customerId ?? proposal.invoice?.customerId;
    if (customerId) group.customerIds.add(customerId);
    if ((PRIORITY_RANK[proposal.insight.priority] ?? 0) > (PRIORITY_RANK[group.priority] ?? 0)) {
      group.priority = proposal.insight.priority;
    }
    proposalGroups.set(proposal.type, group);
  }

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Overview"
        description={`Real-time view of ${context.organization.name}'s receivables.`}
        actions={
          <>
            <Link href={`/app/${orgSlug}/customers/new`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              <UserPlus className="size-4" />
              Add customer
            </Link>
            <Link href={`/app/${orgSlug}/invoices/new`} className={cn(buttonVariants({ variant: "premium", size: "sm" }))}>
              <Plus className="size-4" />
              New invoice
            </Link>
          </>
        }
      />

      <OnboardingChecklist organizationId={context.organization.id} orgSlug={orgSlug} />

      <div>
        <SectionHeader
          title="Today"
          description="Proactive financial insights — what deserves attention right now, cash-flow risk ahead, and what changed."
        />

        <p className="mt-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          PAYNORA Financial Impact
        </p>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ImpactStat
            icon={AlertTriangle}
            value={String(overdueCount)}
            label={overdueCount === 1 ? "invoice needs attention" : "invoices need attention"}
            tone={overdueCount > 0 ? "danger" : "neutral"}
          />
          <ImpactStat
            icon={Receipt}
            value={primaryCurrency ? formatMoney(overdueAtRiskMinor, primaryCurrency) : "—"}
            label="currently overdue"
            tone={overdueAtRiskMinor > 0n ? "danger" : "neutral"}
          />
          <ImpactStat
            icon={CalendarClock}
            value={String(cashFlowRiskCount)}
            label={cashFlowRiskCount === 1 ? "cash-flow risk window" : "cash-flow risk windows"}
            tone={cashFlowRiskCount > 0 ? "warning" : "neutral"}
          />
          <ImpactStat
            icon={Zap}
            value={String(dailyBrief.recommendedActionsCount)}
            label={dailyBrief.recommendedActionsCount === 1 ? "action ready to review" : "actions ready to review"}
            tone={dailyBrief.recommendedActionsCount > 0 ? "primary" : "neutral"}
          />
        </div>

        <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-5">
          <GlassCard level={3} className="p-5 lg:col-span-3">
            <h3 className="text-sm font-semibold text-foreground">Needs attention</h3>
            {dailyBrief.attentionItems.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-2.5">
                {dailyBrief.attentionItems.map((item) => (
                  <TodayAttentionRow key={item.invoiceId} orgSlug={orgSlug} item={item} />
                ))}
              </ul>
            ) : (
              <p className="mt-3 py-6 text-center text-xs text-muted">
                Nothing needs attention today — every overdue invoice already has a reminder proposed.
              </p>
            )}
          </GlassCard>

          <div className="flex flex-col gap-6 lg:col-span-2">
            <GlassCard level={2} className="p-5">
              <div className="flex items-center gap-2">
                <CalendarClock className="size-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">Cash-flow risk — next 3 weeks</h3>
              </div>
              {dailyBrief.primaryCurrency && dailyBrief.cashFlowRiskWindows.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-2 text-xs">
                  {dailyBrief.cashFlowRiskWindows.map((window) => (
                    <li key={window.weekStart} className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">
                        {window.weekStart} – {window.weekEnd}
                      </span>
                      <span className={cn("tabular-nums font-medium", window.isPotentialRisk ? "text-warning" : "text-foreground")}>
                        {formatMoney(window.expectedInMinor, dailyBrief.primaryCurrency!)} expected
                        {window.isPotentialRisk ? " · at risk" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-muted">Not enough open, not-yet-due invoices to estimate this yet.</p>
              )}
            </GlassCard>

            <GlassCard level={2} className="p-5">
              <h3 className="text-sm font-semibold text-foreground">What changed — last 24h</h3>
              {dailyBrief.whatChanged.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-2 text-xs text-muted">
                  {dailyBrief.whatChanged.map((change, index) => (
                    <li key={index}>{change.description}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-muted">Nothing notable in the last 24 hours.</p>
              )}
            </GlassCard>
          </div>
        </div>
      </div>

      {summary.length > 0 ? (
        <div className="flex flex-col gap-6">
          {summary.map((currencySummary) => {
            const currentMinor = currencySummary.totalOutstandingMinor - currencySummary.totalOverdueMinor;
            const isPrimary = currencySummary.currency === primaryCurrency;
            return (
              <div key={currencySummary.currency} className="flex flex-col gap-4">
                {summary.length > 1 ? (
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {currencySummary.currency}
                  </p>
                ) : null}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <MetricCard
                    label="Total Receivables"
                    value={formatMoney(currencySummary.totalOutstandingMinor, currencySummary.currency)}
                    hint={`${currencySummary.openInvoiceCount} open invoice${currencySummary.openInvoiceCount === 1 ? "" : "s"}`}
                    icon={Receipt}
                    changePct={isPrimary ? outstandingChangePct : undefined}
                    sparklineValues={isPrimary ? trend.map((p) => Number(p.outstandingMinor)) : undefined}
                  />
                  <MetricCard
                    label="Overdue Amount"
                    value={formatMoney(currencySummary.totalOverdueMinor, currencySummary.currency)}
                    hint={`${currencySummary.overdueInvoiceCount} invoice${currencySummary.overdueInvoiceCount === 1 ? "" : "s"}`}
                    tone={currencySummary.overdueInvoiceCount > 0 ? "danger" : "neutral"}
                    icon={AlertTriangle}
                  />
                  {isPrimary ? (
                    <>
                      <MetricCard
                        label="Collection Rate"
                        value={`${collectionRatePct.toFixed(1)}%`}
                        hint="Of everything ever issued"
                        tone="success"
                        sparklineValues={trend.map((p) => {
                          const issued = p.outstandingMinor + p.collectedMinor;
                          return issued > 0n ? Number((p.collectedMinor * 1000n) / issued) / 10 : 0;
                        })}
                      />
                      <MetricCard
                        label="Recovered — last 14 days"
                        value={formatMoney(recoveredWindowMinor, currencySummary.currency)}
                        hint="Payments recorded in this window"
                        tone="success"
                        sparklineValues={trend.map((p) => Number(p.collectedMinor))}
                      />
                    </>
                  ) : (
                    <MetricCard
                      label="Current (not yet due)"
                      value={formatMoney(currentMinor, currencySummary.currency)}
                      hint="Still within terms"
                      tone="success"
                      className="sm:col-span-2 xl:col-span-2"
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={Receipt}
          title="No outstanding receivables"
          description="Create a customer and an invoice to start tracking accounts receivable."
          action={
            <Link href={`/app/${orgSlug}/customers/new`} className={cn(buttonVariants())}>
              Add your first customer
            </Link>
          }
        />
      )}

      {primaryCurrency && aging ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <ChartCard
            className="lg:col-span-3"
            title="Receivables Trend"
            description={
              summary.length > 1
                ? `Outstanding vs. collected, ${primaryCurrency} — your largest currency by balance, last 14 days`
                : "Outstanding vs. collected, last 14 days"
            }
            actions={
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: "var(--primary)" }} /> Outstanding
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: "var(--secondary)" }} /> Collected
                </span>
              </div>
            }
          >
            <TrendChart
              labels={trend.map((p) => p.date.slice(5))}
              series={[
                { label: "Outstanding", color: "var(--primary)", values: trend.map((p) => Number(p.outstandingMinor)) },
                { label: "Collected", color: "var(--secondary)", values: trend.map((p) => Number(p.collectedMinor)) },
              ]}
            />
          </ChartCard>

          <ChartCard
            className="lg:col-span-2"
            title="Aging Summary"
            description={`Overdue outstanding, ${primaryCurrency}`}
          >
            {aging.totalOverdueMinor > 0n ? (
              <DonutChart
                centerValue={formatMoney(aging.totalOverdueMinor, primaryCurrency)}
                centerLabel="Total overdue"
                segments={aging.buckets
                  .filter((b) => b.outstandingMinor > 0n)
                  .map((b, i) => ({
                    label: `${b.label} · ${formatMoney(b.outstandingMinor, primaryCurrency)}`,
                    value: Number(b.outstandingMinor),
                    color: AGING_COLORS[i % AGING_COLORS.length]!,
                  }))}
              />
            ) : (
              <p className="py-8 text-center text-sm text-muted">Nothing overdue — every balance is within terms.</p>
            )}
          </ChartCard>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
        <div className="flex flex-col gap-4 lg:col-span-3">
          <SectionHeader
            title="Top overdue invoices"
            description="Most overdue first"
            actions={
              <Link href={`/app/${orgSlug}/invoices?filter=overdue`} className="text-xs font-medium text-primary hover:underline">
                View all
              </Link>
            }
          />
          {overdueTop.length > 0 ? (
            <GlassCard level={1} className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                      <th className="px-5 py-3 font-medium">Customer</th>
                      <th className="px-3 py-3 font-medium">Invoice</th>
                      <th className="px-3 py-3 font-medium">Due date</th>
                      <th className="px-3 py-3 text-right font-medium">Amount</th>
                      <th className="px-5 py-3 text-right font-medium">Days overdue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {overdueTop.map(({ invoice, financials }) => {
                      const overdueDays = daysBetween(toDateOnlyString(invoice.dueDate), today);
                      return (
                        <tr key={invoice.id} className="transition-colors hover:bg-white/[0.03]">
                          <td className="px-5 py-3.5">
                            <Link href={`/app/${orgSlug}/invoices/${invoice.id}`} className="font-medium text-foreground hover:text-primary">
                              {invoice.customer.name}
                            </Link>
                          </td>
                          <td className="px-3 py-3.5 text-muted">{invoice.number}</td>
                          <td className="px-3 py-3.5 text-muted-foreground">{toDateOnlyString(invoice.dueDate)}</td>
                          <td className="px-3 py-3.5 text-right font-medium tabular-nums text-foreground">
                            {formatMoney(financials.outstandingMinor, invoice.currency as Currency)}
                          </td>
                          <td className="px-5 py-3.5 text-right">
                            <Badge tone="danger">{overdueDays}d</Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          ) : (
            <EmptyState title="Nothing overdue" description="No invoices are past their due date." />
          )}

          <SectionHeader title="Recent activity" className="mt-2" />
          {activity.length > 0 ? (
            <GlassCard level={1} className="overflow-hidden">
              <ul className="divide-y divide-border text-sm">
                {activity.map((event) => (
                  <li key={event.id} className="flex items-center justify-between gap-4 px-5 py-3">
                    <span className="text-foreground">{event.summary}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {toDateOnlyString(event.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </GlassCard>
          ) : (
            <EmptyState title="No activity yet" description="Actions on customers and invoices will show up here." />
          )}
        </div>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <AIInsightsPanel
            description={pendingProposals.length > 0 ? `${pendingProposals.length} awaiting review` : undefined}
            footer={
              <Link href={`/app/${orgSlug}/actions`} className="text-xs font-medium text-primary hover:underline">
                Review in Action Center →
              </Link>
            }
          >
            {proposalGroups.size > 0 ? (
              Array.from(proposalGroups.values()).map((group) => (
                <AIInsightCard
                  key={group.type}
                  title={ACTION_TYPE_LABEL[group.type] ?? group.type}
                  detail={`For ${group.customerIds.size} customer${group.customerIds.size === 1 ? "" : "s"} · ${group.count} invoice${group.count === 1 ? "" : "s"}`}
                  impact={PRIORITY_TO_IMPACT[group.priority] ?? "low"}
                />
              ))
            ) : (
              <p className="py-4 text-center text-xs text-muted">No suggestions right now — you&rsquo;re caught up.</p>
            )}
          </AIInsightsPanel>

          <div>
            <SectionHeader title="Quick actions" />
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
              <QuickAction href={`/app/${orgSlug}/invoices/new`} icon={Plus} label="New invoice" />
              <QuickAction href={`/app/${orgSlug}/customers/new`} icon={UserPlus} label="Add customer" />
              <QuickAction href={`/app/${orgSlug}/actions`} icon={Sparkles} label="Review Action Center" />
              <QuickAction href={`/app/${orgSlug}/automation`} icon={Zap} label="Configure automation" />
            </div>
          </div>

          <div>
            <SectionHeader title="Recent payments" />
            {recentPayments.length > 0 ? (
              <Card className="mt-3 overflow-hidden">
                <ul className="divide-y divide-border text-sm">
                  {recentPayments.map((payment) => (
                    <li key={payment.id}>
                      <Link
                        href={`/app/${orgSlug}/invoices/${payment.invoiceId}`}
                        className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-white/[0.03]"
                      >
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">{payment.invoice.number}</span>
                          <span className="text-xs text-muted">{payment.invoice.customer.name}</span>
                        </div>
                        <span className="font-medium tabular-nums text-success">
                          +{formatMoney(payment.amountMinor, payment.invoice.currency as Currency)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : (
              <EmptyState title="No payments recorded yet" className="mt-3 py-8" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const IMPACT_TONE_CLASS: Record<"danger" | "warning" | "primary" | "neutral", string> = {
  danger: "text-danger",
  warning: "text-warning",
  primary: "text-primary",
  neutral: "text-muted-foreground",
};

/**
 * One honest, data-grounded stat in the "PAYNORA Financial Impact" strip
 * (Phase 19, section 8) — never a claimed-savings/ROI figure the system
 * cannot prove, always a fact already computed above ("N invoices need
 * attention", "X currently overdue"), see this file's own doc comment at
 * the call site.
 */
function ImpactStat({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: typeof AlertTriangle;
  value: string;
  label: string;
  tone: "danger" | "warning" | "primary" | "neutral";
}) {
  return (
    <GlassCard level={2} className="flex items-center gap-3 p-4">
      <Icon className={cn("size-5 shrink-0", IMPACT_TONE_CLASS[tone])} />
      <div className="min-w-0">
        <p className={cn("text-lg font-semibold tabular-nums tracking-tight", IMPACT_TONE_CLASS[tone])}>{value}</p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </GlassCard>
  );
}

function QuickAction({ href, icon: Icon, label }: { href: string; icon: typeof Plus; label: string }) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant: "outline" }), "justify-start")}>
      <Icon className="size-4" />
      {label}
    </Link>
  );
}

/**
 * Whether this item already has a pending ActionProposal is itself one of
 * the attention score's own factors (see computeAttentionScore) — reused
 * here rather than a second lookup, so "next step" never contradicts the
 * score's own "Has an unresolved action" factor.
 */
function hasUnresolvedAction(item: DailyBriefAttentionItem): boolean {
  return item.attention.factors.some((factor) => factor.label === "Has an unresolved action" && factor.value === 1);
}

function TodayAttentionRow({ orgSlug, item }: { orgSlug: string; item: DailyBriefAttentionItem }) {
  const nextStep = hasUnresolvedAction(item)
    ? "A reminder is already proposed — review in Action Center."
    : "No reminder proposed yet — run “Check for new actions” in Action Center.";

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border/70 bg-surface-raised/60 p-3.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/app/${orgSlug}/invoices/${item.invoiceId}`}
            className="text-sm font-medium text-foreground hover:text-primary"
          >
            {item.invoiceNumber}
          </Link>
          <span className="text-xs text-muted">— {item.customerName}</span>
          <AttentionScoreBadge score={item.attention.score} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatMoney(item.outstandingMinor, item.currency)} outstanding, {item.daysOverdue}d overdue — mainly due
          to {explainAttentionScore(item.attention).toLowerCase()}.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{nextStep}</p>
      </div>
      <Link
        href={`/app/${orgSlug}/actions`}
        className="inline-flex shrink-0 items-center gap-1 self-start text-xs font-medium text-primary hover:underline"
      >
        Action Center
        <ArrowRight className="size-3" />
      </Link>
    </li>
  );
}
