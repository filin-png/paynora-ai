import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
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

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/app/${orgSlug}/invoices`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Invoices
      </Link>
      <PageHeader title="New invoice" />

      {customers.length === 0 ? (
        <Card className="p-6 text-sm text-muted">
          You need a customer before you can create an invoice.{" "}
          <Link href={`/app/${orgSlug}/customers/new`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-2")}>
            Add a customer
          </Link>
        </Card>
      ) : (
        <Card className="max-w-xl p-6">
          <InvoiceForm
            action={boundAction}
            orgSlug={orgSlug}
            customers={customers}
            suggestedNumber={suggestedNumber}
            defaultCustomerId={customerId}
            today={getBusinessToday()}
          />
        </Card>
      )}
    </div>
  );
}
