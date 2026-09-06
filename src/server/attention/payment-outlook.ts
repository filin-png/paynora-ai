import type { InsightPriority } from "@prisma/client";

import { addDaysToDateOnlyString, daysBetween } from "@/server/ar/dates";
import { listInvoicesWithFinancials } from "@/server/ar/invoices";
import { computeOverduePriority } from "@/server/operator/insights";
import { getAllCustomerPaymentTrends, type PaymentDelayTrend } from "@/server/customer-intelligence/trends";

/**
 * Phase 22 "invoice intelligence" — a grounded, explainable payment
 * outlook for one invoice. Deliberately never a fabricated probability
 * percentage (the phase brief's own constraint #6: "no invented
 * percentages or numbers") — instead a qualitative band derived from two
 * facts this codebase already computes elsewhere:
 *
 * 1. How overdue this invoice already is (`computeOverduePriority` — the
 *    same LOW/MEDIUM/HIGH bucket the Operator/Action Center/invoice list
 *    already use, not a second calculation).
 * 2. This customer's own real payment-delay trend
 *    (`customer-intelligence/trends.ts` — improving/stable/deteriorating,
 *    or honestly "insufficient-history" when there isn't enough real
 *    payment history to say anything).
 *
 * The "expected payment window" is likewise never invented: it is the due
 * date shifted by this customer's own real recent average delay, only
 * when that average exists — never a guess with no data behind it.
 */
export type PaymentOutlookBand = "on-track" | "likely" | "at-risk" | "insufficient-history";

export type PaymentOutlook = {
  band: PaymentOutlookBand;
  /** The due date shifted by the customer's own recent average delay — null when there isn't enough payment history to compute one. */
  expectedPaymentDate: string | null;
  /** One-line, always-grounded explanation of why this band was chosen — never a separate claim that could drift from the facts above. */
  explanation: string;
};

const BAND_LABEL: Record<PaymentOutlookBand, string> = {
  "on-track": "not yet due",
  likely: "likely on time",
  "at-risk": "at risk",
  "insufficient-history": "not enough history",
};

/**
 * The one place a payment outlook is decided — pure, no I/O. `priority` is
 * `null` for an invoice that isn't overdue at all (nothing to outlook yet
 * beyond "not yet due").
 */
export function computePaymentOutlook(
  dueDate: string,
  priority: InsightPriority | null,
  trend: PaymentDelayTrend,
): PaymentOutlook {
  const expectedPaymentDate =
    trend.status !== "insufficient-history" ? addDaysToDateOnlyString(dueDate, Math.round(trend.recentAvgDelayDays)) : null;

  if (priority === null) {
    return {
      band: "on-track",
      expectedPaymentDate,
      explanation:
        trend.status === "insufficient-history"
          ? "Not yet due; not enough payment history for this customer to say more."
          : `Not yet due; this customer's recent average delay is ${trend.recentAvgDelayDays} day(s).`,
    };
  }

  if (trend.status === "deteriorating") {
    const reason =
      priority === "HIGH"
        ? "already significantly overdue"
        : `this customer's payment behavior is deteriorating (recent average delay ${trend.recentAvgDelayDays}d, up from ${trend.previousAvgDelayDays}d)`;
    return { band: "at-risk", expectedPaymentDate, explanation: `At risk — ${reason}.` };
  }

  if (priority === "HIGH") {
    return { band: "at-risk", expectedPaymentDate, explanation: "At risk — already significantly overdue." };
  }

  if (trend.status === "insufficient-history") {
    return {
      band: "insufficient-history",
      expectedPaymentDate,
      explanation: "Not enough payment history for this customer to estimate an outlook.",
    };
  }

  return {
    band: "likely",
    expectedPaymentDate,
    explanation:
      trend.status === "improving"
        ? `Likely on time — this customer's payment behavior is improving (recent average delay ${trend.recentAvgDelayDays}d).`
        : `Likely on time — this customer's payment behavior is stable (recent average delay ${trend.recentAvgDelayDays}d).`,
  };
}

export function paymentOutlookLabel(band: PaymentOutlookBand): string {
  return BAND_LABEL[band];
}

export type InvoicePaymentOutlook = PaymentOutlook & { daysOverdue: number; priority: InsightPriority | null };

/**
 * Bulk lookup for a screen that already knows which invoices it cares
 * about (invoice list, Action Center) — one org-wide trend query
 * (`getAllCustomerPaymentTrends`, itself already a single query grouped in
 * memory) plus the invoice rows already fetched by the caller's own
 * `listInvoicesWithFinancials` call are reused via `invoiceIds`, never a
 * second per-invoice round trip.
 */
export async function getPaymentOutlookForInvoiceIds(
  organizationId: string,
  invoiceIds: string[],
  today: string,
): Promise<Map<string, InvoicePaymentOutlook>> {
  if (invoiceIds.length === 0) return new Map();

  const [invoices, trendsByCustomer] = await Promise.all([
    listInvoicesWithFinancials(organizationId, "all", { invoiceIds }),
    getAllCustomerPaymentTrends(organizationId),
  ]);

  const result = new Map<string, InvoicePaymentOutlook>();
  for (const { invoice, financials } of invoices) {
    if (financials.isPaid) continue;
    const dueDateStr = invoice.dueDate.toISOString().slice(0, 10);
    const daysOverdue = financials.isOverdue ? Math.max(0, daysBetween(dueDateStr, today)) : 0;
    const priority = financials.isOverdue ? computeOverduePriority(daysOverdue) : null;
    const trend = trendsByCustomer.get(invoice.customerId) ?? { status: "insufficient-history" as const };
    const outlook = computePaymentOutlook(dueDateStr, priority, trend);
    result.set(invoice.id, { ...outlook, daysOverdue, priority });
  }
  return result;
}
