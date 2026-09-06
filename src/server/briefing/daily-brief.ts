import type { InsightPriority } from "@prisma/client";

import type { AttentionScore } from "@/server/attention/score";
import { computeAttentionScore } from "@/server/attention/score";
import type { Currency } from "@/server/ar/currency";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { getInvoicesRequiringAttention, getOrganizationArSummary } from "@/server/ar/summary";
import { getCustomerNamesByIds } from "@/server/ar/customers";
import { getAllCustomerPaymentTrends, type PaymentDelayTrend } from "@/server/customer-intelligence/trends";
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

/**
 * A customer whose recent payment behavior has deteriorated
 * (`customer-intelligence/trends.ts`) — always carries the real trend
 * data behind it, never a bare label. `trend.status` is always
 * "deteriorating" by construction (see `getDailyBrief`) — typed as the
 * full `PaymentDelayTrend` rather than a narrower `Extract`, since
 * `PaymentDelayTrend`'s "computed" member shares one status field across
 * improving/deteriorating/stable and isn't itself a per-status variant.
 */
export type DailyBriefDeterioratingCustomer = {
  customerId: string;
  customerName: string;
  trend: PaymentDelayTrend;
};

export type DailyBrief = {
  attentionItems: DailyBriefAttentionItem[];
  recommendedActionsCount: number;
  primaryCurrency: Currency | null;
  cashFlowRiskWindows: CashFlowRiskWindow[];
  whatChanged: ChangeItem[];
  /** Customers whose recent payment behavior has deteriorated — up to MAX_DETERIORATING_CUSTOMERS, worst delta first. Phase 22 section 1 ("clients with deteriorating payment behavior"). */
  customersNeedingAttention: DailyBriefDeterioratingCustomer[];
  /** Sum of outstanding balance across HIGH-priority overdue invoices only — the phase brief's "priority collection amount". Computed from the same `attention` data as `attentionItems`, never a second query. Null when there's no primary currency to sum in. */
  priorityCollectionMinor: bigint | null;
};

const MAX_ATTENTION_ITEMS = 5;
const MAX_DETERIORATING_CUSTOMERS = 5;

export async function getDailyBrief(organizationId: string): Promise<DailyBrief> {
  const [attention, pendingProposals, arSummary, whatChanged, customerTrends] = await Promise.all([
    getInvoicesRequiringAttention(organizationId),
    listPendingActionProposals(organizationId),
    getOrganizationArSummary(organizationId),
    getWhatChanged(organizationId),
    getAllCustomerPaymentTrends(organizationId),
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

  const scoredEntries = overdueOnly.map((entry) => {
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
  });

  const attentionItems: DailyBriefAttentionItem[] = [...scoredEntries]
    .sort((a, b) => b.attention.score - a.attention.score)
    .slice(0, MAX_ATTENTION_ITEMS);

  // Priority collection amount (Phase 22, section 6): every HIGH-priority
  // overdue invoice's outstanding balance, restricted to the primary
  // currency the same way every other single-figure stat on this page is
  // (never summed across currencies — see getOrganizationArSummary's own
  // rule). Reuses `scoredEntries`, computed above for attentionItems —
  // never a second scoring pass.
  const priorityCollectionMinor = primaryCurrency
    ? scoredEntries
        .filter((e) => e.priority === "HIGH" && e.currency === primaryCurrency)
        .reduce((sum, e) => sum + e.outstandingMinor, 0n)
    : null;

  // Customers needing attention (Phase 22, section 1): reuses the exact
  // same trend data the customer detail page and the
  // CUSTOMER_PAYMENT_BEHAVIOR_DETERIORATED detector already compute — no
  // second trend calculation. Worst delta (most days slower) first.
  const deteriorating: { customerId: string; trend: PaymentDelayTrend }[] = [];
  for (const [customerId, trend] of customerTrends) {
    if (trend.status === "deteriorating") deteriorating.push({ customerId, trend });
  }
  const deltaDaysOf = (trend: PaymentDelayTrend): number => (trend.status === "deteriorating" ? trend.deltaDays : 0);
  deteriorating.sort((a, b) => deltaDaysOf(b.trend) - deltaDaysOf(a.trend));
  const topDeteriorating = deteriorating.slice(0, MAX_DETERIORATING_CUSTOMERS);
  const customerNames = await getCustomerNamesByIds(
    organizationId,
    topDeteriorating.map((entry) => entry.customerId),
  );
  const customersNeedingAttention: DailyBriefDeterioratingCustomer[] = [];
  for (const { customerId, trend } of topDeteriorating) {
    const customerName = customerNames.get(customerId);
    if (customerName !== undefined) customersNeedingAttention.push({ customerId, customerName, trend });
  }

  const cashFlowRiskWindows = primaryCurrency ? await getCashFlowRiskWindows(organizationId, primaryCurrency) : [];

  return {
    attentionItems,
    recommendedActionsCount: pendingProposals.length,
    primaryCurrency,
    cashFlowRiskWindows,
    whatChanged,
    customersNeedingAttention,
    priorityCollectionMinor,
  };
}
