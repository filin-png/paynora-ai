import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Currency } from "@/server/ar/currency";
import { listInvoicesWithFinancials, type InvoiceListFilter } from "@/server/ar/invoices";
import { formatMoney } from "@/server/ar/money";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { getInvoiceStatusDisplay } from "./status";

const FILTERS: { value: InvoiceListFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" },
];

export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const { orgSlug } = await params;
  const { filter: rawFilter } = await searchParams;
  const filter: InvoiceListFilter = FILTERS.some((f) => f.value === rawFilter)
    ? (rawFilter as InvoiceListFilter)
    : "all";
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const invoices = await listInvoicesWithFinancials(context.organization.id, filter);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
          <p className="mt-1 text-sm text-muted">
            {invoices.length === 0 ? "No invoices to show." : `${invoices.length} invoice(s).`}
          </p>
        </div>
        <Link
          href={`/app/${orgSlug}/invoices/new`}
          className={cn(buttonVariants({ variant: "primary" }))}
        >
          New invoice
        </Link>
      </div>

      <div className="flex gap-4 text-sm">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={f.value === "all" ? `/app/${orgSlug}/invoices` : `/app/${orgSlug}/invoices?filter=${f.value}`}
            className={filter === f.value ? "font-medium text-foreground" : "text-muted hover:text-foreground"}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {invoices.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {invoices.map(({ invoice, financials }) => {
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
                      due {invoice.dueDate.toISOString().slice(0, 10)}
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
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          No invoices to show.
        </p>
      )}
    </div>
  );
}
