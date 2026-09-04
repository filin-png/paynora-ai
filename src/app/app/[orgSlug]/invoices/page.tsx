import Link from "next/link";
import { Plus, Receipt, Upload } from "lucide-react";

import type { BadgeProps } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { Currency } from "@/server/ar/currency";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { listInvoicesWithFinancials, type InvoiceListFilter } from "@/server/ar/invoices";
import { formatMoney } from "@/server/ar/money";
import { computeOverduePriority } from "@/server/operator/insights";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { getCollectionsBadgesForInvoices } from "../collections-badge";
import { getInvoiceStatusDisplay } from "./status";

// Reuses the exact same priority function the Operator/Action Center use
// for its insight priority (src/server/operator/insights.ts) — never a
// second "how urgent is this" calculation. Only overdue invoices get a
// priority badge; a not-yet-overdue invoice has nothing to prioritize yet.
const PRIORITY_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "neutral",
};

const FILTERS: { value: InvoiceListFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" },
];

// Bounds the invoices list page's query cost regardless of organization
// size — see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-6. `+1` is
// the standard "peek ahead" trick: fetching one extra row reveals whether
// another page exists without a separate COUNT query.
const INVOICE_PAGE_SIZE = 50;

export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ filter?: string; cursor?: string }>;
}) {
  const { orgSlug } = await params;
  const { filter: rawFilter, cursor } = await searchParams;
  const filter: InvoiceListFilter = FILTERS.some((f) => f.value === rawFilter)
    ? (rawFilter as InvoiceListFilter)
    : "all";
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const page = await listInvoicesWithFinancials(context.organization.id, filter, {
    cursor,
    take: INVOICE_PAGE_SIZE + 1,
  });
  const hasMore = page.length > INVOICE_PAGE_SIZE;
  const invoices = hasMore ? page.slice(0, INVOICE_PAGE_SIZE) : page;
  const nextCursor = hasMore ? invoices.at(-1)!.invoice.id : null;
  const collectionsBadges = await getCollectionsBadgesForInvoices(
    context.organization.id,
    invoices.map(({ invoice }) => invoice.id),
  );
  const today = getBusinessToday();

  function pageHref(nextPageCursor: string | null): string {
    const query = new URLSearchParams();
    if (filter !== "all") query.set("filter", filter);
    if (nextPageCursor) query.set("cursor", nextPageCursor);
    const queryString = query.toString();
    return `/app/${orgSlug}/invoices${queryString ? `?${queryString}` : ""}`;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invoices"
        description={
          invoices.length === 0
            ? "No invoices to show."
            : `${invoices.length}${hasMore ? "+" : ""} invoice${invoices.length === 1 && !hasMore ? "" : "s"}.`
        }
        actions={
          <div className="flex gap-2">
            <Link
              href={`/app/${orgSlug}/import?type=invoices`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              <Upload className="size-4" />
              Import
            </Link>
            <Link href={`/app/${orgSlug}/invoices/new`} className={cn(buttonVariants())}>
              <Plus className="size-4" />
              New invoice
            </Link>
          </div>
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
                <TableHead>Priority</TableHead>
                <TableHead>Collections</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map(({ invoice, financials }) => {
                const status = getInvoiceStatusDisplay(invoice, financials);
                const collectionsBadge = collectionsBadges.get(invoice.id) ?? null;
                const daysOverdue = financials.isOverdue ? daysBetween(toDateOnlyString(invoice.dueDate), today) : 0;
                const priority = financials.isOverdue ? computeOverduePriority(daysOverdue) : null;
                return (
                  <TableRow
                    key={invoice.id}
                    className={cn("cursor-pointer", priority === "HIGH" && "border-l-2 border-l-danger")}
                  >
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
                      {priority ? (
                        <Badge tone={PRIORITY_TONE[priority]}>
                          {priority.charAt(0) + priority.slice(1).toLowerCase()} · {daysOverdue}d
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
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

      {hasMore ? (
        <Link href={pageHref(nextCursor)} className={cn(buttonVariants({ variant: "outline" }), "self-center")}>
          Next page
        </Link>
      ) : null}
    </div>
  );
}
