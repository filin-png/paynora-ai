import type { InsightPriority } from "@prisma/client";

/**
 * Phase 16 "what deserves attention right now" — a single explainable
 * score, never a black box. Every factor that contributed is returned
 * alongside the total, so a caller (UI, Copilot, tests) can always show
 * *why* a score is what it is. See
 * docs/proactive-financial-operations.md#attention-priority.
 *
 * Pure and DB-free by design: callers compute `maxOutstandingMinor` once
 * per batch (the largest outstanding balance among the invoices being
 * scored) and pass it in, so scoring many invoices never costs more than
 * one query for the underlying data.
 */
export type AttentionFactor = {
  label: string;
  /** 0..1 — how much of this factor's condition is present. */
  value: number;
  /** Points this factor contributes at maximum (value === 1). */
  maxPoints: number;
};

export type AttentionScore = {
  /** 0..100, rounded. Higher = deserves attention sooner. */
  score: number;
  factors: AttentionFactor[];
};

const PRIORITY_VALUE: Record<InsightPriority, number> = { LOW: 0, MEDIUM: 0.5, HIGH: 1 };

const AMOUNT_MAX_POINTS = 30;
const OVERDUE_MAX_POINTS = 40;
const PRIORITY_MAX_POINTS = 20;
const UNRESOLVED_ACTION_MAX_POINTS = 10;

/** Days overdue at which the overdue factor reaches its maximum (1.0). */
const OVERDUE_SATURATION_DAYS = 30;

export type AttentionScoreInput = {
  outstandingMinor: bigint;
  /** The largest outstanding balance among the invoices being scored in this batch — normalizes amount to 0..1. Zero-safe: 0n disables the amount factor entirely rather than dividing by zero. */
  maxOutstandingMinor: bigint;
  daysOverdue: number;
  priority: InsightPriority;
  /** Whether this invoice/customer already has a pending, unresolved ActionProposal. */
  hasUnresolvedAction: boolean;
};

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * The one place attention is scored. Amount and overdue-days are
 * normalized to 0..1 before weighting — this is a ranking signal, not a
 * financial value, so converting a bigint ratio to Number here is
 * intentional and safe (never used to store or move money).
 */
export function computeAttentionScore(input: AttentionScoreInput): AttentionScore {
  const amountValue =
    input.maxOutstandingMinor > 0n
      ? clamp01(Number(input.outstandingMinor) / Number(input.maxOutstandingMinor))
      : 0;
  const overdueValue = clamp01(input.daysOverdue / OVERDUE_SATURATION_DAYS);
  const priorityValue = PRIORITY_VALUE[input.priority];
  const unresolvedValue = input.hasUnresolvedAction ? 1 : 0;

  const factors: AttentionFactor[] = [
    { label: "Outstanding amount", value: amountValue, maxPoints: AMOUNT_MAX_POINTS },
    { label: "Days overdue", value: overdueValue, maxPoints: OVERDUE_MAX_POINTS },
    { label: "Insight priority", value: priorityValue, maxPoints: PRIORITY_MAX_POINTS },
    { label: "Has an unresolved action", value: unresolvedValue, maxPoints: UNRESOLVED_ACTION_MAX_POINTS },
  ];

  const score = Math.round(factors.reduce((sum, f) => sum + f.value * f.maxPoints, 0));
  return { score, factors };
}
