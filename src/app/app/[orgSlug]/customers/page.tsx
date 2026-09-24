import Link from "next/link";
import { Plus, Upload, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { getDictionary } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
import { pluralForm } from "@/lib/i18n/plural";
import { cn } from "@/lib/utils";
import { listCustomers } from "@/server/ar/customers";
import { formatMoney } from "@/server/ar/money";
import { getCustomerReceivablesSummaries } from "@/server/ar/summary";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";

// Bounds the customers list page's query cost regardless of organization
// size — see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-6. `+1` is
// the standard "peek ahead" trick: fetching one extra row reveals whether
// another page exists without a separate COUNT query.
const CUSTOMER_PAGE_SIZE = 50;

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ archived?: string; cursor?: string }>;
}) {
  const { orgSlug } = await params;
  const { archived, cursor } = await searchParams;
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = dict.customers;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const showArchived = archived === "1";
  const [page, receivables] = await Promise.all([
    listCustomers(context.organization.id, {
      includeArchived: showArchived,
      cursor,
      take: CUSTOMER_PAGE_SIZE + 1,
    }),
    getCustomerReceivablesSummaries(context.organization.id),
  ]);
  const hasMore = page.length > CUSTOMER_PAGE_SIZE;
  const customers = hasMore ? page.slice(0, CUSTOMER_PAGE_SIZE) : page;
  const nextCursor = hasMore ? customers.at(-1)!.id : null;

  function pageHref(nextPageCursor: string | null): string {
    const query = new URLSearchParams();
    if (showArchived) query.set("archived", "1");
    if (nextPageCursor) query.set("cursor", nextPageCursor);
    const queryString = query.toString();
    return `/app/${orgSlug}/customers${queryString ? `?${queryString}` : ""}`;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t.title}
        description={
          customers.length === 0
            ? t.noCustomers
            : `${customers.length}${hasMore ? "+" : ""} ${pluralForm(customers.length, locale, {
                one: t.countOne,
                few: t.countFew,
                many: t.countMany,
              })}`
        }
        actions={
          <div className="flex gap-2">
            <Link
              href={`/app/${orgSlug}/import?type=customers`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              <Upload className="size-4" />
              {dict.common.import}
            </Link>
            <Link href={`/app/${orgSlug}/customers/new`} className={cn(buttonVariants())}>
              <Plus className="size-4" />
              {t.newCustomer}
            </Link>
          </div>
        }
      />

      <Tabs
        items={[
          { href: `/app/${orgSlug}/customers`, label: t.filterActive, active: !showArchived },
          { href: `/app/${orgSlug}/customers?archived=1`, label: t.filterIncludeArchived, active: showArchived },
        ]}
      />

      {customers.length > 0 ? (
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.columnCustomer}</TableHead>
                <TableHead>{t.columnEmail}</TableHead>
                <TableHead className="text-right">{t.columnOpenInvoices}</TableHead>
                <TableHead className="text-right">{t.columnOutstanding}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((customer) => {
                const summary = receivables.get(customer.id);
                return (
                  <TableRow key={customer.id}>
                    <TableCell className="p-0">
                      <Link href={`/app/${orgSlug}/customers/${customer.id}`} className="flex items-center gap-2 px-4 py-3.5 font-medium text-foreground">
                        {customer.name}
                        {customer.archivedAt ? <Badge tone="neutral">{t.archived}</Badge> : null}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted">{customer.email ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted">{summary?.openInvoiceCount ?? 0}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium text-foreground">
                      {summary && summary.outstandingByCurrency.length > 0
                        ? summary.outstandingByCurrency
                            .map((entry) => formatMoney(entry.outstandingMinor, entry.currency))
                            .join(" · ")
                        : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <EmptyState
          icon={Users}
          title={t.emptyTitle}
          description={t.emptyDescription}
          action={
            <Link href={`/app/${orgSlug}/customers/new`} className={cn(buttonVariants())}>
              {t.emptyAction}
            </Link>
          }
        />
      )}

      {hasMore ? (
        <Link href={pageHref(nextCursor)} className={cn(buttonVariants({ variant: "outline" }), "self-center")}>
          {dict.common.nextPage}
        </Link>
      ) : null}
    </div>
  );
}
