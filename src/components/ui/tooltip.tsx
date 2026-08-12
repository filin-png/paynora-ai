import { cn } from "@/lib/utils";

/**
 * A minimal, JS-free tooltip (pure CSS group-hover/focus) — used sparingly,
 * only where a label genuinely needs a short clarification (e.g. an
 * internal status term). Not for anything load-bearing: the trigger's own
 * visible text/label must always stand alone.
 */
export function Tooltip({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("group relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-max max-w-56 -translate-x-1/2 rounded-md bg-navy-900 px-2.5 py-1.5 text-xs text-navy-foreground opacity-0 shadow-card-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
