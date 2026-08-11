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
  const customer = await getCustomer(context.organization.id, customerId);
  const boundAction = updateCustomerAction.bind(null, orgSlug, customerId);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Edit {customer.name}</h1>
      <div className="mt-8">
        <CustomerForm action={boundAction} defaultValues={customer} submitLabel="Save changes" />
      </div>
    </div>
  );
}
