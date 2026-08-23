import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { GlassCard } from "@/components/ui/glass-card";
import { Badge } from "@/components/ui/badge";

export type AIInsightImpact = "high" | "medium" | "low";

const IMPACT_LABEL: Record<AIInsightImpact, string> = {
  high: "High impact",
  medium: "Medium impact",
  low: "Low impact",
};
const IMPACT_TONE: Record<AIInsightImpact, "danger" | "warning" | "neutral"> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

/**
 * One row inside the Overview's "AI Suggestions" panel. Visually distinct
 * from a plain list item (subtle purple glow ring, sparkle mark) but
 * restrained — no pulsing/looping animation, per the "no cheap AI magic"
 * instruction. Renders only real proposals passed in by the caller.
 */
export function AIInsightCard({
  title,
  detail,
  impact,
  action,
  className,
}: {
  title: React.ReactNode;
  detail: React.ReactNode;
  impact: AIInsightImpact;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border/70 bg-surface-raised/60 p-3.5 transition-colors hover:border-primary/30",
        className,
      )}
    >
      <span
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-primary"
        style={{ background: "var(--accent-soft)", boxShadow: "0 0 0 1px var(--glass-border)" }}
      >
        <Sparkles className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <Badge tone={IMPACT_TONE[impact]} className="shrink-0">
            {IMPACT_LABEL[impact]}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted">{detail}</p>
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

/** Panel wrapper for a list of AIInsightCard rows — level-3 glass, sparkle header. */
export function AIInsightsPanel({
  title = "AI Suggestions",
  description,
  children,
  footer,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <GlassCard level={3} className="p-5">
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Sparkles className="size-3.5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2.5">{children}</div>
      {footer ? <div className="mt-3">{footer}</div> : null}
    </GlassCard>
  );
}
