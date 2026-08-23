import * as React from "react";

import { cn } from "@/lib/utils";

export type GlassLevel = 1 | 2 | 3;

const LEVEL_CLASS: Record<GlassLevel, string> = {
  1: "bg-surface border border-border shadow-card-sm",
  2: "glass-surface shadow-card-md",
  3: "glass-elevated",
};

/**
 * The three surface levels of the dark financial design system — see
 * docs/product-ui.md#design-system. Level 1 is a plain `Card` in practice
 * (this component exists so level 2/3 glass and elevated surfaces share
 * one implementation instead of each screen hand-rolling backdrop-blur +
 * border + shadow combinations).
 */
export function GlassCard({
  level = 2,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { level?: GlassLevel }) {
  return <div className={cn("rounded-xl", LEVEL_CLASS[level], className)} {...props} />;
}
