import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

export type MetricTone = "neutral" | "success" | "warning" | "danger";

const TONE_ICON_BG: Record<MetricTone, string> = {
  neutral: "bg-accent-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

/**
 * The primary financial-summary building block for the dashboard. Renders
 * only real, already-computed values passed in by the caller — see
 * docs/product-ui.md#real-data-only. `hint` is for a short qualifier
 * ("across 4 open invoices"), never a fabricated trend.
 */
export function MetricCard({
  label,
  value,
  hint,
  tone = "neutral",
  icon: Icon,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: MetricTone;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <Card className={cn("p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon ? (
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", TONE_ICON_BG[tone])}>
            <Icon className="size-4" />
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value}</p>
      {hint ? <p className="mt-1.5 text-xs text-muted">{hint}</p> : null}
    </Card>
  );
}
