import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
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
    <div className="flex flex-col gap-6">
      <Link
        href={`/app/${orgSlug}/customers`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Customers
      </Link>
      <PageHeader title="New customer" />
      <Card className="max-w-xl p-6">
        <CustomerForm action={boundAction} orgSlug={orgSlug} submitLabel="Create customer" />
      </Card>
    </div>
  );
}
