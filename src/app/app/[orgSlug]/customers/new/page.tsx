import { CustomerForm } from "../customer-form";
import { createCustomerAction } from "./actions";

export default async function NewCustomerPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const boundAction = createCustomerAction.bind(null, orgSlug);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">New customer</h1>
      <div className="mt-8">
        <CustomerForm action={boundAction} submitLabel="Create customer" />
      </div>
    </div>
  );
}
