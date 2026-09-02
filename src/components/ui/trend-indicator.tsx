import { Minus, TrendingDown, TrendingUp } from "lucide-react";

import type { PaymentDelayTrend } from "@/server/customer-intelligence/trends";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Phase 16 — renders a customer's deterministic payment-delay trend
 * (src/server/customer-intelligence/trends.ts). "Improving" means paying
 * faster (fewer days late), never a financial-health opinion beyond that.
 * Always honest about insufficient history — never invents a direction.
 */
const TREND_DISPLAY: Record<
  Exclude<PaymentDelayTrend["status"], "insufficient-history">,
  { label: string; tone: "success" | "danger" | "neutral"; icon: typeof TrendingUp }
> = {
  improving: { label: "Improving", tone: "success", icon: TrendingDown },
  deteriorating: { label: "Deteriorating", tone: "danger", icon: TrendingUp },
  stable: { label: "Stable", tone: "neutral", icon: Minus },
};

export function TrendBadge({ trend, className }: { trend: PaymentDelayTrend; className?: string }) {
  if (trend.status === "insufficient-history") {
    return (
      <Badge tone="neutral" className={className}>
        Not enough history
      </Badge>
    );
  }
  const display = TREND_DISPLAY[trend.status];
  const Icon = display.icon;
  return (
    <Badge tone={display.tone} className={cn("gap-1", className)}>
      <Icon className="size-3" />
      {display.label}
    </Badge>
  );
}
