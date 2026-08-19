import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * Link-driven tabs — deliberately not client-side state. Every tabbed
 * screen in this app (Settings) is a set of real routes/query params, so
 * navigating a tab is a real navigation (shareable URL, works without JS,
 * no client component needed just to switch a view). See
 * docs/product-ui.md#design-system.
 */
export function Tabs({
  items,
  className,
}: {
  items: { href: string; label: string; active: boolean; disabled?: boolean }[];
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1 overflow-x-auto border-b border-border", className)} role="tablist">
      {items.map((item) =>
        item.disabled ? (
          <span
            key={item.href}
            role="tab"
            aria-disabled="true"
            aria-selected={false}
            className="shrink-0 cursor-not-allowed border-b-2 border-transparent px-3 py-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground/60"
          >
            {item.label}
          </span>
        ) : (
          <Link
            key={item.href}
            href={item.href}
            role="tab"
            aria-selected={item.active}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
              item.active
                ? "border-primary text-primary"
                : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        ),
      )}
    </div>
  );
}
