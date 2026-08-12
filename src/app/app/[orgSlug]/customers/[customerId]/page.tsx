import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, Phone, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogCancelButton } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { isResourceNotFoundError } from "@/lib/not-found";
import { listCustomerActivity } from "@/server/ar/activity";
import { getCustomer } from "@/server/ar/customers";
import { listInvoicesWithFinancials } from "@/server/ar/invoices";
import { formatMoney } from "@/server/ar/money";
import type { Currency } from "@/server/ar/currency";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { getInvoiceStatusDisplay } from "../../invoices/status";
import { archiveCustomerAction } from "./actions";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; customerId: string }>;
}) {
  const { orgSlug, customerId } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const customer = await getCustomer(context.organization.id, customerId).catch((error: unknown) => {
    if (isResourceNotFoundError(error)) notFound();
    throw error;
  });
  const invoices = await listInvoicesWithFinancials(context.organization.id, "all", { customerId });
  const activity = await listCustomerActivity(context.organization.id, customerId);
  const boundArchive = archiveCustomerAction.bind(null, orgSlug, customerId);

  const openInvoices = invoices.filter(({ invoice, financials }) => invoice.status === "OPEN" && !financials.isPaid);
  const outstandingByCurrency = new Map<string, bigint>();
  for (const { invoice, financials } of openInvoices) {
    outstandingByCurrency.set(invoice.currency, (outstandingByCurrency.get(invoice.currency) ?? 0n) + financials.outstandingMinor);
  }

  return (
    <div className="flex flex-col gap-10">
      <div>
        <Link
          href={`/app/${orgSlug}/customers`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Customers
        </Link>

        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{customer.name}</h1>
              {customer.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              {customer.email ? (
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="size-3.5" />
                  {customer.email}
                </span>
              ) : null}
              {customer.phone ? (
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="size-3.5" />
                  {customer.phone}
                </span>
              ) : null}
              {customer.companyName ? <span>{customer.companyName}</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link href={`/app/${orgSlug}/customers/${customerId}/edit`} className={cn(buttonVariants({ variant: "outline" }))}>
              Edit
            </Link>
            {!customer.archivedAt ? (
              <Dialog
                trigger={<Button type="button" variant="outline">Archive</Button>}
                title="Archive this customer?"
                description="Archived customers are hidden from the invoice picker, but their existing invoices and payments are unaffected."
              >
                <div className="flex justify-end gap-2">
                  <DialogCancelButton className={cn(buttonVariants({ variant: "outline", size: "sm" }))} />
                  <form action={boundArchive}>
                    <button type="submit" className={cn(buttonVariants({ size: "sm" }))}>
                      Archive customer
                    </button>
                  </form>
                </div>
              </Dialog>
            ) : null}
          </div>
        </div>
      </div>

      {outstandingByCurrency.size > 0 ? (
        <Card className="flex flex-wrap gap-8 p-5">
          {Array.from(outstandingByCurrency.entries()).map(([currency, amount]) => (
            <div key={currency}>
              <p className="text-xs font-medium text-muted-foreground">Outstanding ({currency})</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                {formatMoney(amount, currency as Currency)}
              </p>
            </div>
          ))}
          <div>
            <p className="text-xs font-medium text-muted-foreground">Open invoices</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">{openInvoices.length}</p>
          </div>
        </Card>
      ) : null}

      {customer.notes ? (
        <Card className="p-5">
          <p className="text-xs font-medium text-muted-foreground">Notes</p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">{customer.notes}</p>
        </Card>
      ) : null}

      <div>
        <SectionHeader
          title="Invoices"
          actions={
            !customer.archivedAt ? (
              <Link href={`/app/${orgSlug}/invoices/new?customerId=${customerId}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                <Plus className="size-4" />
                New invoice
              </Link>
            ) : undefined
          }
        />
        {invoices.length > 0 ? (
          <Card className="mt-3 overflow-hidden">
            <ul className="divide-y divide-border">
              {invoices.map(({ invoice, financials }) => {
                const status = getInvoiceStatusDisplay(invoice, financials);
                return (
                  <li key={invoice.id}>
                    <Link
                      href={`/app/${orgSlug}/invoices/${invoice.id}`}
                      className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm transition-colors hover:bg-accent-soft"
                    >
                      <span className="font-medium text-foreground">{invoice.number}</span>
                      <div className="flex items-center gap-3">
                        <span className="tabular-nums text-muted">
                          {formatMoney(financials.outstandingMinor, invoice.currency as Currency)} outstanding
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
          <EmptyState className="mt-3 py-10" title="No invoices for this customer yet" />
        )}
      </div>

      <div>
        <SectionHeader title="Activity" />
        {activity.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-2.5 text-sm">
            {activity.map((event) => (
              <li key={event.id} className="flex items-baseline justify-between gap-4">
                <span className="text-foreground">{event.summary}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{event.createdAt.toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">No activity yet.</p>
        )}
      </div>
    </div>
  );
}
