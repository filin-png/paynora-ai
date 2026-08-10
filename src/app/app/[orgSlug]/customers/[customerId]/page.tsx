import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listCustomerActivity } from "@/server/ar/activity";
import { getCustomer } from "@/server/ar/customers";
import { listInvoicesWithFinancials } from "@/server/ar/invoices";
import { formatMoney } from "@/server/ar/money";
import type { Currency } from "@/server/ar/currency";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { archiveCustomerAction } from "./actions";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; customerId: string }>;
}) {
  const { orgSlug, customerId } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const customer = await getCustomer(context.organization.id, customerId);
  const invoices = await listInvoicesWithFinancials(context.organization.id, "all", { customerId });
  const activity = await listCustomerActivity(context.organization.id, customerId);
  const boundArchive = archiveCustomerAction.bind(null, orgSlug, customerId);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {customer.name}
            {customer.archivedAt ? (
              <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted">
                Archived
              </span>
            ) : null}
          </h1>
          <div className="mt-1 flex flex-col text-sm text-muted">
            {customer.email ? <span>{customer.email}</span> : null}
            {customer.phone ? <span>{customer.phone}</span> : null}
            {customer.companyName ? <span>{customer.companyName}</span> : null}
          </div>
        </div>
        <div className="flex gap-3">
          <Link
            href={`/app/${orgSlug}/customers/${customerId}/edit`}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Edit
          </Link>
          {!customer.archivedAt ? (
            <form action={boundArchive}>
              <button
                type="submit"
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Archive
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {customer.notes ? (
        <p className="whitespace-pre-wrap text-sm text-muted">{customer.notes}</p>
      ) : null}

      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Invoices</h2>
          {!customer.archivedAt ? (
            <Link
              href={`/app/${orgSlug}/invoices/new?customerId=${customerId}`}
              className="text-sm font-medium text-foreground hover:underline"
            >
              New invoice
            </Link>
          ) : null}
        </div>
        {invoices.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
            {invoices.map(({ invoice, financials }) => (
              <li key={invoice.id}>
                <Link
                  href={`/app/${orgSlug}/invoices/${invoice.id}`}
                  className="flex items-center justify-between px-4 py-3 text-sm hover:bg-foreground/5"
                >
                  <span className="font-medium">{invoice.number}</span>
                  <span className="text-muted">
                    {formatMoney(financials.outstandingMinor, invoice.currency as Currency)} outstanding
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">No invoices for this customer yet.</p>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold">Activity</h2>
        {activity.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {activity.map((event) => (
              <li key={event.id} className="flex justify-between gap-4 text-muted">
                <span>{event.summary}</span>
                <span className="shrink-0">{event.createdAt.toISOString().slice(0, 10)}</span>
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
