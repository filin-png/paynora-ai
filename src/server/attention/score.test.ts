import { describe, expect, it } from "vitest";

import { computeAttentionScore } from "./score";

describe("computeAttentionScore", () => {
  it("scores 0 for an invoice with no amount, no overdue days, LOW priority, and no unresolved action", () => {
    const result = computeAttentionScore({
      outstandingMinor: 0n,
      maxOutstandingMinor: 100_00n,
      daysOverdue: 0,
      priority: "LOW",
      hasUnresolvedAction: false,
    });
    expect(result.score).toBe(0);
  });

  it("scores 100 at maximum amount, maximum overdue days, HIGH priority, and an unresolved action", () => {
    const result = computeAttentionScore({
      outstandingMinor: 100_00n,
      maxOutstandingMinor: 100_00n,
      daysOverdue: 30,
      priority: "HIGH",
      hasUnresolvedAction: true,
    });
    expect(result.score).toBe(100);
  });

  it("caps the overdue-days factor at its saturation point rather than growing past it", () => {
    const at30 = computeAttentionScore({
      outstandingMinor: 0n,
      maxOutstandingMinor: 0n,
      daysOverdue: 30,
      priority: "LOW",
      hasUnresolvedAction: false,
    });
    const at365 = computeAttentionScore({
      outstandingMinor: 0n,
      maxOutstandingMinor: 0n,
      daysOverdue: 365,
      priority: "LOW",
      hasUnresolvedAction: false,
    });
    expect(at30.score).toBe(at365.score);
  });

  it("never divides by zero when maxOutstandingMinor is zero", () => {
    const result = computeAttentionScore({
      outstandingMinor: 500_00n,
      maxOutstandingMinor: 0n,
      daysOverdue: 5,
      priority: "MEDIUM",
      hasUnresolvedAction: false,
    });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.factors.find((f) => f.label === "Outstanding amount")?.value).toBe(0);
  });

  it("returns explainable factors that sum to the total score", () => {
    const result = computeAttentionScore({
      outstandingMinor: 50_00n,
      maxOutstandingMinor: 100_00n,
      daysOverdue: 15,
      priority: "MEDIUM",
      hasUnresolvedAction: true,
    });
    const sum = result.factors.reduce((total, f) => total + f.value * f.maxPoints, 0);
    expect(result.score).toBe(Math.round(sum));
    expect(result.factors.length).toBeGreaterThan(0);
    for (const factor of result.factors) {
      expect(factor.value).toBeGreaterThanOrEqual(0);
      expect(factor.value).toBeLessThanOrEqual(1);
    }
  });

  it("a larger outstanding amount scores higher than a smaller one, all else equal", () => {
    const small = computeAttentionScore({
      outstandingMinor: 10_00n,
      maxOutstandingMinor: 100_00n,
      daysOverdue: 10,
      priority: "MEDIUM",
      hasUnresolvedAction: false,
    });
    const large = computeAttentionScore({
      outstandingMinor: 90_00n,
      maxOutstandingMinor: 100_00n,
      daysOverdue: 10,
      priority: "MEDIUM",
      hasUnresolvedAction: false,
    });
    expect(large.score).toBeGreaterThan(small.score);
  });
});
