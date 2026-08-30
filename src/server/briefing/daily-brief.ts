import type { InsightPriority } from "@prisma/client";

import type { AttentionScore } from "@/server/attention/score";
import { computeAttentionScore } from "@/server/attention/score";
import type { Currency } from "@/server/ar/currency";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { getInvoicesRequiringAttention, getOrganizationArSummary } from "@/server/ar/summary";
import { computeOverduePriority } from "@/server/operator/insights";
import { listPendingActionProposals } from "@/server/operator/approval";
import { getCashFlowRiskWindows, type CashFlowRiskWindow } from "./cash-flow-risk";
import { getWhatChanged, type ChangeItem } from "./what-changed";

/**
 * Phase 16 Daily Brief — the read-time aggregation behind the Overview
 * page's "Today" section. Nothing here is persisted; every field is
 * recomputed from the same deterministic sources the rest of the app
 * already reads (getInvoicesRequiringAttention, listPendingActionProposals,
 * getCashFlowRiskWindows, getWhatChanged) — see
 * docs/proactive-financial-operations.md#daily-brief.
 */
export type DailyBriefAttentionItem = {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  currency: Currency;
  outstandingMinor: bigint;
  daysOverdue: number;
  priority: InsightPriority;
  attention: AttentionScore;
};

export type DailyBrief = {
  attentionItems: DailyBriefAttentionItem[];
  recommendedActionsCount: number;
  primaryCurrency: Currency | null;
  cashFlowRiskWindows: CashFlowRiskWindow[];
  whatChanged: ChangeItem[];
};

const MAX_ATTENTION_ITEMS = 5;

export async function getDailyBrief(organizationId: string): Promise<DailyBrief> {
  const [attention, pendingProposals, arSummary, whatChanged] = await Promise.all([
    getInvoicesRequiringAttention(organizationId),
    listPendingActionProposals(organizationId),
    getOrganizationArSummary(organizationId),
    getWhatChanged(organizationId),
  ]);

  const primaryCurrency: Currency | null =
    arSummary.length > 0
      ? arSummary.reduce((a, b) => (b.totalOutstandingMinor > a.totalOutstandingMinor ? b : a)).currency
      : null;

  const invoiceIdsWithPendingAction = new Set(
    pendingProposals.map((p) => p.invoiceId).filter((id): id is string => id !== null),
  );

  const today = getBusinessToday();
  const overdueOnly = attention.filter((entry) => entry.reason === "overdue");
  const maxOutstandingMinor = overdueOnly.reduce(
    (max, entry) => (entry.financials.outstandingMinor > max ? entry.financials.outstandingMinor : max),
    0n,
  );

  const attentionItems: DailyBriefAttentionItem[] = overdueOnly
    .map((entry) => {
      const daysOverdue = daysBetween(toDateOnlyString(entry.invoice.dueDate), today);
      const priority = computeOverduePriority(daysOverdue);
      const attentionScore = computeAttentionScore({
        outstandingMinor: entry.financials.outstandingMinor,
        maxOutstandingMinor,
        daysOverdue,
        priority,
        hasUnresolvedAction: invoiceIdsWithPendingAction.has(entry.invoice.id),
      });
      return {
        invoiceId: entry.invoice.id,
        invoiceNumber: entry.invoice.number,
        customerName: entry.invoice.customer.name,
        currency: entry.invoice.currency as Currency,
        outstandingMinor: entry.financials.outstandingMinor,
        daysOverdue,
        priority,
        attention: attentionScore,
      };
    })
    .sort((a, b) => b.attention.score - a.attention.score)
    .slice(0, MAX_ATTENTION_ITEMS);

  const cashFlowRiskWindows = primaryCurrency ? await getCashFlowRiskWindows(organizationId, primaryCurrency) : [];

  return {
    attentionItems,
    recommendedActionsCount: pendingProposals.length,
    primaryCurrency,
    cashFlowRiskWindows,
    whatChanged,
  };
}
