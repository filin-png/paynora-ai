import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while a page under `/app/[orgSlug]` is loading (the layout itself
 * has already resolved by this point — see docs/product-ui.md#loading).
 * A generic content skeleton rather than per-page ones: most pages here
 * share the same header + card-list shape, so one skeleton covers the
 * common case honestly without pretending to preview exact content.
 */
export default function OrganizationSectionLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-2">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
