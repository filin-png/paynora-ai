import Link from "next/link";
import { AlertTriangle, Plus, Receipt, Sparkles, UserPlus, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { listOrganizationActivity } from "@/server/ar/activity";
import type { Currency } from "@/server/ar/currency";
import { formatMoney } from "@/server/ar/money";
import {
  getInvoicesRequiringAttention,
  getOrganizationArSummary,
  listRecentPayments,
} from "@/server/ar/summary";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { getInvoiceStatusDisplay } from "./invoices/status";
import { OnboardingChecklist } from "./onboarding-checklist";

export default async function OrganizationDashboardPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const [summary, attention, recentPayments, activity] = await Promise.all([
    getOrganizationArSummary(context.organization.id),
    getInvoicesRequiringAttention(context.organization.id),
    listRecentPayments(context.organization.id, 5),
    listOrganizationActivity(context.organization.id, 8),
  ]);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Overview"
        description={`What's happening with ${context.organization.name}'s receivables right now.`}
        actions={
          <>
            <Link href={`/app/${orgSlug}/customers/new`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              <UserPlus className="size-4" />
              Add customer
            </Link>
            <Link href={`/app/${orgSlug}/invoices/new`} className={cn(buttonVariants({ size: "sm" }))}>
              <Plus className="size-4" />
              New invoice
            </Link>
          </>
        }
      />

      <OnboardingChecklist organizationId={context.organization.id} orgSlug={orgSlug} />

      {summary.length > 0 ? (
        <div className="flex flex-col gap-6">
          {summary.map((currencySummary) => {
            const currentMinor = currencySummary.totalOutstandingMinor - currencySummary.totalOverdueMinor;
            const overduePct =
              currencySummary.totalOutstandingMinor > 0n
                ? Number((currencySummary.totalOverdueMinor * 100n) / currencySummary.totalOutstandingMinor)
                : 0;
            return (
              <div key={currencySummary.currency} className="flex flex-col gap-4">
                {summary.length > 1 ? (
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {currencySummary.currency}
                  </p>
                ) : null}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <MetricCard
                    label="Total outstanding"
                    value={formatMoney(currencySummary.totalOutstandingMinor, currencySummary.currency)}
                    hint={`${currencySummary.openInvoiceCount} open invoice${currencySummary.openInvoiceCount === 1 ? "" : "s"}`}
                    icon={Receipt}
                  />
                  <MetricCard
                    label="Overdue"
                    value={formatMoney(currencySummary.totalOverdueMinor, currencySummary.currency)}
                    hint={`${currencySummary.overdueInvoiceCount} invoice${currencySummary.overdueInvoiceCount === 1 ? "" : "s"}`}
                    tone={currencySummary.overdueInvoiceCount > 0 ? "danger" : "neutral"}
                    icon={AlertTriangle}
                  />
                  <MetricCard
                    label="Current (not yet due)"
                    value={formatMoney(currentMinor, currencySummary.currency)}
                    hint="Still within terms"
                    tone="success"
                  />
                </div>

                <Card className="p-5">
                  <p className="text-xs font-medium text-muted-foreground">Receivables status</p>
                  <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-border">
                    {overduePct > 0 ? <div className="h-full bg-danger" style={{ width: `${overduePct}%` }} /> : null}
                    <div className="h-full flex-1 bg-success/70" />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-danger" /> Overdue
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-success/70" /> Current
                    </span>
                  </div>
                </Card>
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

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
        <div className="flex flex-col gap-4 lg:col-span-3">
          <SectionHeader
            title="Needs attention"
            description="Overdue, or due within 7 days"
            actions={
              <Link href={`/app/${orgSlug}/invoices?filter=overdue`} className="text-xs font-medium text-primary hover:underline">
                View all
              </Link>
            }
          />
          {attention.length > 0 ? (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-border">
                {attention.map(({ invoice, financials, reason }) => {
                  const status = getInvoiceStatusDisplay(invoice, financials);
                  return (
                    <li key={invoice.id}>
                      <Link
                        href={`/app/${orgSlug}/invoices/${invoice.id}`}
                        className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm transition-colors hover:bg-accent-soft"
                      >
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">{invoice.number}</span>
                          <span className="text-muted">{invoice.customer.name}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="hidden text-xs text-muted-foreground sm:inline">
                            {reason === "overdue" ? "overdue" : "due"} {invoice.dueDate.toISOString().slice(0, 10)}
                          </span>
                          <span className="font-medium tabular-nums text-foreground">
                            {formatMoney(financials.outstandingMinor, invoice.currency as Currency)}
                          </span>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : (
            <EmptyState title="Nothing needs attention" description="No invoices are overdue or due soon." />
          )}

          <SectionHeader title="Recent activity" className="mt-2" />
          {activity.length > 0 ? (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-border text-sm">
                {activity.map((event) => (
                  <li key={event.id} className="flex items-center justify-between gap-4 px-5 py-3">
                    <span className="text-foreground">{event.summary}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {event.createdAt.toISOString().slice(0, 10)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : (
            <EmptyState title="No activity yet" description="Actions on customers and invoices will show up here." />
          )}
        </div>

        <div className="flex flex-col gap-6 lg:col-span-2">
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
                        className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent-soft"
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

function QuickAction({ href, icon: Icon, label }: { href: string; icon: typeof Plus; label: string }) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant: "outline" }), "justify-start")}>
      <Icon className="size-4" />
      {label}
    </Link>
  );
}
