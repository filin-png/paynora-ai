import { CreateOrganizationForm } from "./organization-form";

export default function NewOrganizationPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Create an organization</h1>
      <p className="mt-1 text-sm text-muted">
        You&apos;ll become its owner and can invite others later.
      </p>
      <CreateOrganizationForm />
    </div>
  );
}
