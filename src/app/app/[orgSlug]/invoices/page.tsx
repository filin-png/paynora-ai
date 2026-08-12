import Link from "next/link";
import { Plus, Receipt } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { Currency } from "@/server/ar/currency";
import { listInvoicesWithFinancials, type InvoiceListFilter } from "@/server/ar/invoices";
import { formatMoney } from "@/server/ar/money";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { getCollectionsBadgesForInvoices } from "../collections-badge";
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
  const collectionsBadges = await getCollectionsBadgesForInvoices(
    context.organization.id,
    invoices.map(({ invoice }) => invoice.id),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invoices"
        description={invoices.length === 0 ? "No invoices to show." : `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}.`}
        actions={
          <Link href={`/app/${orgSlug}/invoices/new`} className={cn(buttonVariants())}>
            <Plus className="size-4" />
            New invoice
          </Link>
        }
      />

      <Tabs
        items={FILTERS.map((f) => ({
          href: f.value === "all" ? `/app/${orgSlug}/invoices` : `/app/${orgSlug}/invoices?filter=${f.value}`,
          label: f.label,
          active: filter === f.value,
        }))}
      />

      {invoices.length > 0 ? (
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Collections</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map(({ invoice, financials }) => {
                const status = getInvoiceStatusDisplay(invoice, financials);
                const collectionsBadge = collectionsBadges.get(invoice.id) ?? null;
                return (
                  <TableRow key={invoice.id} className="cursor-pointer">
                    <TableCell className="p-0">
                      <Link href={`/app/${orgSlug}/invoices/${invoice.id}`} className="block px-4 py-3.5 font-medium text-foreground">
                        {invoice.number}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted">{invoice.customer.name}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted">
                      {formatMoney(financials.amountMinor, invoice.currency as Currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-foreground">
                      {formatMoney(financials.outstandingMinor, invoice.currency as Currency)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted">{invoice.dueDate.toISOString().slice(0, 10)}</TableCell>
                    <TableCell>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {collectionsBadge ? <Badge tone={collectionsBadge.tone}>{collectionsBadge.label}</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <EmptyState
          icon={Receipt}
          title="No invoices yet"
          description="Create your first invoice to start tracking receivables."
          action={
            <Link href={`/app/${orgSlug}/invoices/new`} className={cn(buttonVariants())}>
              Create your first invoice
            </Link>
          }
        />
      )}
    </div>
  );
}
