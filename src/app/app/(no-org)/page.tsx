import Link from "next/link";
import { ArrowRight, Building2 } from "lucide-react";

import { PaynoraMark } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listUserOrganizations } from "@/server/tenancy/organizations";
import { requireUserForPage } from "@/server/tenancy/guards";

export default async function AppHomePage() {
  const user = await requireUserForPage();
  const organizations = await listUserOrganizations(user);

  if (organizations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-6 text-center">
        <PaynoraMark size={40} />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Welcome to PAYNORA, {user.name ?? user.email.split("@")[0]}
          </h1>
          <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
            Create your workspace to start tracking receivables, customers, and invoices.
          </p>
        </div>
        <Link href="/app/organizations/new" className={cn(buttonVariants({ size: "lg" }))}>
          Create your workspace
          <ArrowRight className="size-4" />
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Your workspaces</h1>
        <p className="mt-1 text-sm text-muted">Select one to continue.</p>
      </div>

      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-card-sm">
        {organizations.map((organization) => (
          <li key={organization.id}>
            <Link
              href={`/app/${organization.slug}`}
              className="flex items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-accent-soft"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-primary">
                  <Building2 className="size-4.5" />
                </span>
                <span className="font-medium text-foreground">{organization.name}</span>
              </div>
              <span className="text-xs font-medium text-muted-foreground">
                {organization.role === "OWNER" ? "Owner" : "Member"}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <Link
        href="/app/organizations/new"
        className={cn(buttonVariants({ variant: "outline" }), "self-center")}
      >
        Create another workspace
      </Link>
    </div>
  );
}
