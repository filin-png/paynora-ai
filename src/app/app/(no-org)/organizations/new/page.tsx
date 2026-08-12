import { PaynoraMark } from "@/components/brand/logo";
import { CreateOrganizationForm } from "./organization-form";

export default function NewOrganizationPage() {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <PaynoraMark size={36} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Create your workspace</h1>
        <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
          This is where your customers, invoices, and collection activity will live.
          You&apos;ll become its owner and can invite others later.
        </p>
      </div>
      <div className="w-full text-left">
        <CreateOrganizationForm />
      </div>
    </div>
  );
}
