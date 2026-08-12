import Link from "next/link";
import { Plus, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { listCustomers } from "@/server/ar/customers";
import { formatMoney } from "@/server/ar/money";
import { getCustomerReceivablesSummaries } from "@/server/ar/summary";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ archived?: string }>;
}) {
  const { orgSlug } = await params;
  const { archived } = await searchParams;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const showArchived = archived === "1";
  const [customers, receivables] = await Promise.all([
    listCustomers(context.organization.id, { includeArchived: showArchived }),
    getCustomerReceivablesSummaries(context.organization.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Customers"
        description={customers.length === 0 ? "No customers yet." : `${customers.length} customer${customers.length === 1 ? "" : "s"}.`}
        actions={
          <Link href={`/app/${orgSlug}/customers/new`} className={cn(buttonVariants())}>
            <Plus className="size-4" />
            New customer
          </Link>
        }
      />

      <Tabs
        items={[
          { href: `/app/${orgSlug}/customers`, label: "Active", active: !showArchived },
          { href: `/app/${orgSlug}/customers?archived=1`, label: "Include archived", active: showArchived },
        ]}
      />

      {customers.length > 0 ? (
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="text-right">Open invoices</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
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
                        {customer.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
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
          title="No customers yet"
          description="Add your first customer to start invoicing them."
          action={
            <Link href={`/app/${orgSlug}/customers/new`} className={cn(buttonVariants())}>
              Add your first customer
            </Link>
          }
        />
      )}
    </div>
  );
}
