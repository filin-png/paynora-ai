import type { AttentionScore } from "@/server/attention/score";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Phase 16 — renders an explainable AttentionScore (never a bare number
 * with no way to see why). See docs/proactive-financial-operations.md
 * #attention-priority for the scoring model this displays.
 */
function toneForScore(score: number): "danger" | "warning" | "neutral" {
  if (score >= 70) return "danger";
  if (score >= 40) return "warning";
  return "neutral";
}

export function AttentionScoreBadge({ score, className }: { score: number; className?: string }) {
  return (
    <Badge tone={toneForScore(score)} className={cn("tabular-nums", className)}>
      Attention {score}
    </Badge>
  );
}

/**
 * The two factors contributing the most points, in plain language — the
 * deterministic "why" behind a score, computed from the same `factors`
 * array the score itself was built from (never a separate explanation).
 */
export function explainAttentionScore(attention: AttentionScore): string {
  const contributing = attention.factors
    .map((factor) => ({ ...factor, points: factor.value * factor.maxPoints }))
    .filter((factor) => factor.points > 0)
    .sort((a, b) => b.points - a.points);

  if (contributing.length === 0) return "Flagged for review.";
  return contributing
    .slice(0, 2)
    .map((factor) => factor.label)
    .join(" and ");
}

export function AttentionScoreDetail({ attention, className }: { attention: AttentionScore; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-2">
        <AttentionScoreBadge score={attention.score} />
        <span className="text-xs text-muted-foreground">out of 100</span>
      </div>
      <ul className="flex flex-col gap-0.5 text-xs text-muted">
        {attention.factors
          .filter((factor) => factor.value > 0)
          .map((factor) => (
            <li key={factor.label}>
              {factor.label}: {Math.round(factor.value * factor.maxPoints)}/{factor.maxPoints} pts
            </li>
          ))}
      </ul>
    </div>
  );
}
