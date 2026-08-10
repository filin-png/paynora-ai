import { listCustomers } from "@/server/ar/customers";
import { getBusinessToday } from "@/server/ar/dates";
import { prisma } from "@/server/db/client";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { createInvoiceAction } from "./actions";
import { InvoiceForm } from "./invoice-form";

async function suggestNextInvoiceNumber(organizationId: string): Promise<string> {
  const count = await prisma.invoice.count({ where: { organizationId } });
  return `INV-${String(count + 1).padStart(4, "0")}`;
}

export default async function NewInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ customerId?: string }>;
}) {
  const { orgSlug } = await params;
  const { customerId } = await searchParams;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const [customers, suggestedNumber] = await Promise.all([
    listCustomers(context.organization.id),
    suggestNextInvoiceNumber(context.organization.id),
  ]);
  const boundAction = createInvoiceAction.bind(null, orgSlug);

  if (customers.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New invoice</h1>
        <p className="mt-4 text-sm text-muted">
          You need a customer before you can create an invoice — create one first.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">New invoice</h1>
      <div className="mt-8">
        <InvoiceForm
          action={boundAction}
          customers={customers}
          suggestedNumber={suggestedNumber}
          defaultCustomerId={customerId}
          today={getBusinessToday()}
        />
      </div>
    </div>
  );
}
