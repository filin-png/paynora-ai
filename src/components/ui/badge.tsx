import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "border-border text-muted",
        success:
          "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
        warning: "border-amber-600/30 bg-amber-600/10 text-amber-700 dark:text-amber-400",
        danger: "border-red-600/30 bg-red-600/10 text-red-700 dark:text-red-400",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ tone, className, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
