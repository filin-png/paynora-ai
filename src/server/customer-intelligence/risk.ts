import { computeAttentionScore } from "@/server/attention/score";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { listInvoicesWithFinancials } from "@/server/ar/invoices";
import { listPendingActionProposals } from "@/server/operator/approval";
import { computeOverduePriority } from "@/server/operator/insights";
import { getCustomerPaymentTrend, type PaymentDelayTrend } from "./trends";

/**
 * Phase 22 "customer intelligence" — a customer-level view built entirely
 * from data this codebase already computes per-invoice, never a second
 * risk-scoring system. `currentRiskScore` is the highest
 * `computeAttentionScore` (src/server/attention/score.ts — the same
 * scoring function the invoice list, Action Center, and Overview "Today"
 * section already use) among this customer's own open, overdue invoices —
 * a customer's risk is only ever as high as their riskiest open invoice,
 * never an invented separate customer-level formula.
 */
export type CustomerRiskLevel = "none" | "low" | "medium" | "high";

export type CustomerRiskProfile = {
  riskLevel: CustomerRiskLevel;
  /** The highest attention score among this customer's open, overdue invoices — 0 when none are overdue. */
  currentRiskScore: number;
  trend: PaymentDelayTrend;
  /** Always grounded in the facts above — never a separate claim that could drift from them. */
  recommendedNextAction: string;
  openOverdueInvoiceCount: number;
};

function riskLevelForScore(score: number): CustomerRiskLevel {
  if (score <= 0) return "none";
  if (score < 40) return "low";
  if (score < 70) return "medium";
  return "high";
}

export async function getCustomerRiskProfile(
  organizationId: string,
  customerId: string,
): Promise<CustomerRiskProfile> {
  const today = getBusinessToday();
  const [invoices, trend, pendingProposals] = await Promise.all([
    listInvoicesWithFinancials(organizationId, "all", { customerId }),
    getCustomerPaymentTrend(organizationId, customerId),
    listPendingActionProposals(organizationId),
  ]);

  const overdueOpen = invoices.filter(({ financials }) => financials.isOverdue && !financials.isPaid);
  const maxOutstandingMinor = overdueOpen.reduce(
    (max, { financials }) => (financials.outstandingMinor > max ? financials.outstandingMinor : max),
    0n,
  );
  const invoiceIdsWithPendingAction = new Set(
    pendingProposals.map((p) => p.invoiceId).filter((id): id is string => id !== null),
  );

  let currentRiskScore = 0;
  let riskiestInvoiceId: string | null = null;
  let riskiestHasPendingAction = false;
  for (const { invoice, financials } of overdueOpen) {
    const daysOverdue = daysBetween(toDateOnlyString(invoice.dueDate), today);
    const priority = computeOverduePriority(daysOverdue);
    const { score } = computeAttentionScore({
      outstandingMinor: financials.outstandingMinor,
      maxOutstandingMinor,
      daysOverdue,
      priority,
      hasUnresolvedAction: invoiceIdsWithPendingAction.has(invoice.id),
    });
    if (score > currentRiskScore) {
      currentRiskScore = score;
      riskiestInvoiceId = invoice.id;
      riskiestHasPendingAction = invoiceIdsWithPendingAction.has(invoice.id);
    }
  }

  const riskLevel = riskLevelForScore(currentRiskScore);

  let recommendedNextAction: string;
  if (overdueOpen.length === 0) {
    recommendedNextAction =
      trend.status === "deteriorating"
        ? "No overdue invoices right now, but recent payments have been arriving later — worth keeping an eye on."
        : "No overdue invoices — nothing needs action for this customer right now.";
  } else if (riskiestHasPendingAction) {
    recommendedNextAction = "A payment reminder is already proposed for this customer's riskiest invoice — review it in Action Center.";
  } else if (riskiestInvoiceId) {
    recommendedNextAction = "No reminder proposed yet for this customer's riskiest invoice — run \"Check for new actions\" in Action Center.";
  } else {
    recommendedNextAction = "Nothing needs action for this customer right now.";
  }

  return {
    riskLevel,
    currentRiskScore,
    trend,
    recommendedNextAction,
    openOverdueInvoiceCount: overdueOpen.length,
  };
}
