import type { InsightPriority } from "@prisma/client";

import type { AttentionScore } from "./score";
import { computeAttentionScore } from "./score";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { listInvoicesWithFinancials } from "@/server/ar/invoices";
import { computeOverduePriority } from "@/server/operator/insights";

export type InvoiceAttention = {
  attention: AttentionScore;
  daysOverdue: number;
  priority: InsightPriority;
};

/**
 * Bulk attention-score lookup for a known set of invoice ids — reuses the
 * exact same computeAttentionScore/computeOverduePriority pair
 * getDailyBrief (src/server/briefing/daily-brief.ts) uses for the Overview
 * "Today" section, rather than a second scoring implementation. Intended
 * for screens that already know which invoices they care about (Action
 * Center proposal cards) instead of scanning every overdue invoice in the
 * organization the way getDailyBrief does for its top-5 ranking.
 *
 * `invoiceIdsWithUnresolvedAction` mirrors getDailyBrief's own
 * `hasUnresolvedAction` factor — pass the set of invoice ids that already
 * have a pending ActionProposal so the score reflects it the same way.
 * Days overdue is clamped to 0 for an invoice that isn't overdue (a
 * not-yet-due invoice never gets a negative "days overdue" factor).
 */
export async function getAttentionScoresForInvoiceIds(
  organizationId: string,
  invoiceIds: string[],
  invoiceIdsWithUnresolvedAction: ReadonlySet<string> = new Set(),
): Promise<Map<string, InvoiceAttention>> {
  if (invoiceIds.length === 0) return new Map();

  const today = getBusinessToday();
  const invoices = await listInvoicesWithFinancials(organizationId, "all", { invoiceIds });

  const maxOutstandingMinor = invoices.reduce(
    (max, { financials }) => (financials.outstandingMinor > max ? financials.outstandingMinor : max),
    0n,
  );

  const result = new Map<string, InvoiceAttention>();
  for (const { invoice, financials } of invoices) {
    const daysOverdue = Math.max(0, daysBetween(toDateOnlyString(invoice.dueDate), today));
    const priority = computeOverduePriority(daysOverdue);
    const attention = computeAttentionScore({
      outstandingMinor: financials.outstandingMinor,
      maxOutstandingMinor,
      daysOverdue,
      priority,
      hasUnresolvedAction: invoiceIdsWithUnresolvedAction.has(invoice.id),
    });
    result.set(invoice.id, { attention, daysOverdue, priority });
  }
  return result;
}
