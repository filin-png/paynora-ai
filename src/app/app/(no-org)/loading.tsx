import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while `/app` or `/app/organizations/new` is loading (the
 * `(no-org)` layout's header has already resolved by this point — same
 * pattern as `[orgSlug]/loading.tsx`). Both pages this route group
 * renders share the same centered, narrow shape (see
 * `(no-org)/layout.tsx`'s `max-w-lg` container), so one generic skeleton
 * covers both honestly rather than guessing which one is loading.
 */
export default function NoOrgSectionLoading() {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <Skeleton className="size-10 rounded-full" />
      <div className="flex flex-col items-center gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-11 w-48 rounded-md" />
    </div>
  );
}
