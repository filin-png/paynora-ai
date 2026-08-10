import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type { Currency } from "@/server/ar/currency";
import { formatMoney } from "@/server/ar/money";
import {
  getInvoicesRequiringAttention,
  getOrganizationArSummary,
  listRecentPayments,
} from "@/server/ar/summary";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { getInvoiceStatusDisplay } from "./invoices/status";

export default async function OrganizationDashboardPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const [summary, attention, recentPayments] = await Promise.all([
    getOrganizationArSummary(context.organization.id),
    getInvoicesRequiringAttention(context.organization.id),
    listRecentPayments(context.organization.id, 5),
  ]);

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">{context.organization.name}</p>
      </div>

      {summary.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {summary.map((currencySummary) => (
            <div key={currencySummary.currency} className="rounded-md border border-border p-6">
              <p className="text-xs font-medium text-muted">{currencySummary.currency}</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight">
                {formatMoney(currencySummary.totalOutstandingMinor, currencySummary.currency)}
              </p>
              <p className="mt-1 text-xs text-muted">
                total outstanding across {currencySummary.openInvoiceCount} open invoice(s)
              </p>
              <div className="mt-4 flex items-center justify-between border-t border-border pt-4 text-sm">
                <span className="text-muted">Overdue</span>
                <span className="font-medium text-red-600 dark:text-red-400">
                  {formatMoney(currencySummary.totalOverdueMinor, currencySummary.currency)} (
                  {currencySummary.overdueInvoiceCount})
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          No outstanding receivables. Create a customer and an invoice to get started.
        </p>
      )}

      <div>
        <h2 className="text-sm font-semibold">Invoices requiring attention</h2>
        {attention.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
            {attention.map(({ invoice, financials, reason }) => {
              const status = getInvoiceStatusDisplay(invoice, financials);
              return (
                <li key={invoice.id}>
                  <Link
                    href={`/app/${orgSlug}/invoices/${invoice.id}`}
                    className="flex items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-foreground/5"
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">{invoice.number}</span>
                      <span className="text-muted">{invoice.customer.name}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-muted">
                        {reason === "overdue" ? "overdue" : "due"} {invoice.dueDate.toISOString().slice(0, 10)}
                      </span>
                      <span className="font-medium">
                        {formatMoney(financials.outstandingMinor, invoice.currency as Currency)}
                      </span>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">Nothing needs attention right now.</p>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold">Recent payments</h2>
        {recentPayments.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
            {recentPayments.map((payment) => (
              <li key={payment.id}>
                <Link
                  href={`/app/${orgSlug}/invoices/${payment.invoiceId}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-foreground/5"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{payment.invoice.number}</span>
                    <span className="text-muted">{payment.invoice.customer.name}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-muted">{payment.paidAt.toISOString().slice(0, 10)}</span>
                    <span className="font-medium">
                      {formatMoney(payment.amountMinor, payment.invoice.currency as Currency)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">No payments recorded yet.</p>
        )}
      </div>
    </div>
  );
}
