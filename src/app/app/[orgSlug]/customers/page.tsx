import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listCustomers } from "@/server/ar/customers";
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
  const customers = await listCustomers(context.organization.id, { includeArchived: showArchived });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 text-sm text-muted">
            {customers.length === 0 ? "No customers yet." : `${customers.length} customer(s).`}
          </p>
        </div>
        <Link
          href={`/app/${orgSlug}/customers/new`}
          className={cn(buttonVariants({ variant: "primary" }))}
        >
          New customer
        </Link>
      </div>

      <div className="flex gap-4 text-sm">
        <Link
          href={`/app/${orgSlug}/customers`}
          className={showArchived ? "text-muted hover:text-foreground" : "font-medium text-foreground"}
        >
          Active
        </Link>
        <Link
          href={`/app/${orgSlug}/customers?archived=1`}
          className={showArchived ? "font-medium text-foreground" : "text-muted hover:text-foreground"}
        >
          Include archived
        </Link>
      </div>

      {customers.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {customers.map((customer) => (
            <li key={customer.id}>
              <Link
                href={`/app/${orgSlug}/customers/${customer.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-foreground/5"
              >
                <div className="flex flex-col">
                  <span className="font-medium">
                    {customer.name}
                    {customer.archivedAt ? (
                      <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted">
                        Archived
                      </span>
                    ) : null}
                  </span>
                  {customer.email ? (
                    <span className="text-sm text-muted">{customer.email}</span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          No customers to show. Create your first customer to start invoicing.
        </p>
      )}
    </div>
  );
}
