"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Scoped to `/app/[orgSlug]` so an error here still renders inside the
 * sidebar/header shell (the layout keeps rendering; only this segment's
 * content is replaced) instead of falling back to the bare root error
 * page. Never presents a server error as success — see
 * docs/product-ui.md#error-states.
 */
export default function OrganizationSectionError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="danger" title="Something went wrong loading this page">
        Try again, or navigate to a different section.
      </Alert>
      <Button onClick={reset} variant="outline" className="self-start">
        Try again
      </Button>
    </div>
  );
}
