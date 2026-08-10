import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listUserOrganizations } from "@/server/tenancy/organizations";
import { requireUserForPage } from "@/server/tenancy/guards";

export default async function AppHomePage() {
  const user = await requireUserForPage();
  const organizations = await listUserOrganizations(user);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Your organizations</h1>
        <p className="mt-1 text-sm text-muted">
          {organizations.length === 0
            ? "You don't belong to an organization yet."
            : "Select an organization to continue."}
        </p>
      </div>

      {organizations.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link
                href={`/app/${organization.slug}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-foreground/5"
              >
                <span className="font-medium">{organization.name}</span>
                <span className="text-xs text-muted">{organization.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <div>
        <Link
          href="/app/organizations/new"
          className={cn(buttonVariants({ variant: "primary" }))}
        >
          Create organization
        </Link>
      </div>
    </div>
  );
}
