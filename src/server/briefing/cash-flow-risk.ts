import type { Currency } from "@/server/ar/currency";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { listInvoicesWithFinancials } from "@/server/ar/invoices";
import { getOrganizationArSummary } from "@/server/ar/summary";

/**
 * Phase 16 cash-flow risk windows — extends the existing AR summary layer
 * (getOrganizationArSummary, listInvoicesWithFinancials), it does not
 * replace or duplicate it. There was no forward-looking cash-flow forecast
 * in this codebase before Phase 16 — getReceivablesTrend
 * (src/server/ar/summary.ts) is historical (trailing 14 days), not
 * predictive — so this is new functionality, not an extension of an
 * existing forecast, despite the brief's baseline assumption otherwise.
 * See docs/proactive-financial-operations.md#cash-flow-risk-windows.
 *
 * The model is deliberately simple and honestly caveated: for each
 * upcoming week, "expected" is the total of currently-open, not-yet-due
 * invoices whose due date falls in that week — money the business is
 * genuinely scheduled to receive, not invented. "Estimated at risk" is
 * that amount multiplied by this organization's *own* historical overdue
 * rate (how much of everything currently outstanding is overdue right
 * now) — a real, derived-from-this-org number, never an invented
 * probability model. A week is flagged only when a meaningful amount is
 * both expected and, based on this org's own recent behavior, plausibly
 * at risk of turning into another the overdue invoice instead of being
 * collected on time.
 */
export type CashFlowRiskWindow = {
  weekStart: string;
  weekEnd: string;
  expectedInMinor: bigint;
  invoiceCount: number;
  estimatedAtRiskMinor: bigint;
  /** True only when there is real expected inflow AND this org's historical overdue rate is meaningful — never a guess with no data behind it. */
  isPotentialRisk: boolean;
};

const WEEK_DAYS = 7;
const MEANINGFUL_OVERDUE_RATE = 0.25;

function addDays(dateStr: string, days: number): string {
  const ms = Date.parse(`${dateStr}T00:00:00.000Z`) + days * 86_400_000;
  return toDateOnlyString(new Date(ms));
}

export async function getCashFlowRiskWindows(
  organizationId: string,
  currency: Currency,
  weekCount = 3,
): Promise<CashFlowRiskWindow[]> {
  const today = getBusinessToday();
  const [openInvoices, arSummary] = await Promise.all([
    listInvoicesWithFinancials(organizationId, "open"),
    getOrganizationArSummary(organizationId),
  ]);

  const currencySummary = arSummary.find((s) => s.currency === currency);
  const overdueRate =
    currencySummary && currencySummary.totalOutstandingMinor > 0n
      ? Number(currencySummary.totalOverdueMinor) / Number(currencySummary.totalOutstandingMinor)
      : 0;

  const windows: CashFlowRiskWindow[] = [];
  for (let i = 0; i < weekCount; i += 1) {
    const weekStart = addDays(today, i * WEEK_DAYS);
    const weekEnd = addDays(today, (i + 1) * WEEK_DAYS - 1);

    let expectedInMinor = 0n;
    let invoiceCount = 0;
    for (const { invoice, financials } of openInvoices) {
      if ((invoice.currency as Currency) !== currency) continue;
      if (financials.isPaid || financials.isOverdue) continue;
      const dueDateStr = toDateOnlyString(invoice.dueDate);
      if (dueDateStr < weekStart || dueDateStr > weekEnd) continue;
      expectedInMinor += financials.outstandingMinor;
      invoiceCount += 1;
    }

    const estimatedAtRiskMinor = BigInt(Math.round(Number(expectedInMinor) * overdueRate));
    windows.push({
      weekStart,
      weekEnd,
      expectedInMinor,
      invoiceCount,
      estimatedAtRiskMinor,
      isPotentialRisk: expectedInMinor > 0n && overdueRate >= MEANINGFUL_OVERDUE_RATE,
    });
  }

  return windows;
}

/** Re-exported for tests and callers that need "days until a window starts" without recomputing today twice. */
export function daysUntil(dateStr: string): number {
  return daysBetween(getBusinessToday(), dateStr);
}
