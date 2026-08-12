import Link from "next/link";
import { FileQuestion } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Catches `notFound()` for anything under `/app/[orgSlug]` — a mistyped
 * or cross-tenant invoice/customer/proposal id, most commonly (see
 * src/lib/not-found.ts). Renders inside the org shell (sidebar/header
 * still show), not a bare error page. Links back to the dashboard rather
 * than a relative "../", which would land somewhere different (and not
 * necessarily valid) depending on how deep the not-found route was.
 */
export default async function OrganizationSectionNotFound({
  params,
}: {
  params?: Promise<{ orgSlug: string }>;
}) {
  const resolved = await params;
  const dashboardHref = resolved ? `/app/${resolved.orgSlug}` : "/app";

  return (
    <EmptyState
      icon={FileQuestion}
      title="We couldn't find that"
      description="It may have been removed, or the link might be incorrect."
      action={
        <Link href={dashboardHref} className={cn(buttonVariants({ variant: "outline" }))}>
          Back to dashboard
        </Link>
      }
      className="mt-10"
    />
  );
}
