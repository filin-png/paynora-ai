import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { isResourceNotFoundError } from "@/lib/not-found";
import { getCustomer } from "@/server/ar/customers";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { CustomerForm } from "../../customer-form";
import { updateCustomerAction } from "../actions";

export default async function EditCustomerPage({
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
  const boundAction = updateCustomerAction.bind(null, orgSlug, customerId);

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/app/${orgSlug}/customers/${customerId}`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {customer.name}
      </Link>
      <PageHeader title={`Edit ${customer.name}`} />
      <Card className="max-w-xl p-6">
        <CustomerForm action={boundAction} defaultValues={customer} submitLabel="Save changes" />
      </Card>
    </div>
  );
}
