import type { LucideIcon } from "lucide-react";
import { TrendingDown, TrendingUp } from "lucide-react";

import { cn } from "@/lib/utils";
import { GlassCard } from "@/components/ui/glass-card";
import { Sparkline } from "@/components/ui/charts";

export type MetricTone = "neutral" | "success" | "warning" | "danger";

const TONE_ICON_BG: Record<MetricTone, string> = {
  neutral: "bg-accent-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

const TONE_SPARKLINE_COLOR: Record<MetricTone, string> = {
  neutral: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
};

/**
 * The primary financial-summary building block for the dashboard. Renders
 * only real, already-computed values passed in by the caller — see
 * docs/product-ui.md#real-data-only. `hint` is for a short qualifier
 * ("across 4 open invoices"), never a fabricated trend. `changePct` and
 * `sparklineValues`, when passed, must also come from real computed data
 * (e.g. the receivables trend series) — never invented for visual effect.
 */
export function MetricCard({
  label,
  value,
  hint,
  tone = "neutral",
  icon: Icon,
  changePct,
  sparklineValues,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: MetricTone;
  icon?: LucideIcon;
  changePct?: number;
  sparklineValues?: number[];
  className?: string;
}) {
  const hasChange = typeof changePct === "number" && Number.isFinite(changePct);
  const isUp = hasChange && changePct! >= 0;

  return (
    <GlassCard level={2} className={cn("p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon ? (
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", TONE_ICON_BG[tone])}>
            <Icon className="size-4" />
          </span>
        ) : null}
      </div>
      <p className="mt-3 font-[family-name:var(--font-mono)] text-[1.75rem] leading-none font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </p>
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {hasChange ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-xs font-medium tabular-nums",
                isUp ? "text-success" : "text-danger",
              )}
            >
              {isUp ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
              {isUp ? "+" : ""}
              {changePct!.toFixed(1)}%
            </span>
          ) : null}
          {hint ? <p className="text-xs text-muted">{hint}</p> : null}
        </div>
        {sparklineValues && sparklineValues.length > 1 ? (
          <Sparkline values={sparklineValues} color={TONE_SPARKLINE_COLOR[tone]} />
        ) : null}
      </div>
    </GlassCard>
  );
}
