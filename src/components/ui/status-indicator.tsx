import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const dotVariants = cva("inline-block size-2 shrink-0 rounded-full", {
  variants: {
    tone: {
      neutral: "bg-muted-foreground",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-danger",
      info: "bg-primary",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type StatusIndicatorProps = VariantProps<typeof dotVariants> & {
  label: string;
  className?: string;
};

/** A dot + label — for states that don't warrant a full Badge pill (e.g. inline in a dense table row). */
export function StatusIndicator({ tone, label, className }: StatusIndicatorProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm text-foreground", className)}>
      <span className={dotVariants({ tone })} aria-hidden="true" />
      {label}
    </span>
  );
}
