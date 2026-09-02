import { prisma } from "@/server/db/client";
import { daysBetween, toDateOnlyString } from "@/server/ar/dates";

/**
 * Phase 16 customer behavior intelligence — deterministic only, never an
 * AI opinion. See docs/proactive-financial-operations.md#customer-trends.
 *
 * A trend compares the customer's most recent `TREND_WINDOW_SIZE`
 * payments against the `TREND_WINDOW_SIZE` before those — never a single
 * payment, and never invented when there isn't enough real history.
 */
export const TREND_WINDOW_SIZE = 3;
const MIN_PAYMENTS_PER_WINDOW = 2;
const DETERIORATION_THRESHOLD_DAYS = 3;
const IMPROVEMENT_THRESHOLD_DAYS = 3;

export type PaymentDelayTrend =
  | { status: "insufficient-history" }
  | {
      status: "improving" | "deteriorating" | "stable";
      recentAvgDelayDays: number;
      previousAvgDelayDays: number;
      deltaDays: number;
      recentPaymentCount: number;
      previousPaymentCount: number;
    };

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Delay in whole days between an invoice's due date and when it was
 * actually paid — floored at 0 (paid early or on time is 0 delay, never
 * negative, so an early payment can't drag down an average in a way that
 * misrepresents "how late does this customer pay").
 */
export function paymentDelayDays(dueDate: Date, paidAt: Date): number {
  const delay = daysBetween(toDateOnlyString(dueDate), toDateOnlyString(paidAt));
  return delay > 0 ? delay : 0;
}

/**
 * The one place a trend is actually decided — pure, no I/O, fully unit
 * testable. `recentDelays`/`previousDelays` must already be in
 * chronological order (oldest first) is NOT required here; only their
 * count and values matter. Below `MIN_PAYMENTS_PER_WINDOW` on either side,
 * always reports "insufficient-history" — never an invented direction.
 */
export function computeTrendFromDelays(recentDelays: number[], previousDelays: number[]): PaymentDelayTrend {
  if (recentDelays.length < MIN_PAYMENTS_PER_WINDOW || previousDelays.length < MIN_PAYMENTS_PER_WINDOW) {
    return { status: "insufficient-history" };
  }

  const recentAvg = average(recentDelays);
  const previousAvg = average(previousDelays);
  const delta = recentAvg - previousAvg;

  let status: "improving" | "deteriorating" | "stable" = "stable";
  if (delta >= DETERIORATION_THRESHOLD_DAYS) status = "deteriorating";
  else if (delta <= -IMPROVEMENT_THRESHOLD_DAYS) status = "improving";

  return {
    status,
    recentAvgDelayDays: round1(recentAvg),
    previousAvgDelayDays: round1(previousAvg),
    deltaDays: round1(delta),
    recentPaymentCount: recentDelays.length,
    previousPaymentCount: previousDelays.length,
  };
}

function splitIntoWindows(
  delaysOldestFirst: number[],
): { recent: number[]; previous: number[] } {
  const recent = delaysOldestFirst.slice(-TREND_WINDOW_SIZE);
  const previous = delaysOldestFirst.slice(-TREND_WINDOW_SIZE * 2, -TREND_WINDOW_SIZE);
  return { recent, previous };
}

/**
 * Single-customer lookup for the customer detail page — one query, scoped
 * to this organization and customer. See getAllCustomerPaymentTrends for
 * the bulk variant the Phase 16 detector uses instead (avoids an N+1
 * query per customer).
 */
export async function getCustomerPaymentTrend(
  organizationId: string,
  customerId: string,
): Promise<PaymentDelayTrend> {
  const payments = await prisma.payment.findMany({
    where: { organizationId, invoice: { customerId } },
    select: { paidAt: true, invoice: { select: { dueDate: true } } },
    orderBy: { paidAt: "asc" },
  });

  const delays = payments.map((p) => paymentDelayDays(p.invoice.dueDate, p.paidAt));
  const { recent, previous } = splitIntoWindows(delays);
  return computeTrendFromDelays(recent, previous);
}

/**
 * Bulk variant: one query for every payment in the organization, grouped
 * by customer in memory — the same "single org-wide query, group locally"
 * pattern already used by getCustomerReceivablesSummaries
 * (src/server/ar/summary.ts), so scanning every customer's trend never
 * costs one query per customer.
 */
export async function getAllCustomerPaymentTrends(
  organizationId: string,
): Promise<Map<string, PaymentDelayTrend>> {
  const payments = await prisma.payment.findMany({
    where: { organizationId },
    select: { paidAt: true, invoice: { select: { customerId: true, dueDate: true } } },
    orderBy: { paidAt: "asc" },
  });

  const delaysByCustomer = new Map<string, number[]>();
  for (const payment of payments) {
    const customerId = payment.invoice.customerId;
    const delay = paymentDelayDays(payment.invoice.dueDate, payment.paidAt);
    const existing = delaysByCustomer.get(customerId) ?? [];
    existing.push(delay);
    delaysByCustomer.set(customerId, existing);
  }

  const result = new Map<string, PaymentDelayTrend>();
  for (const [customerId, delays] of delaysByCustomer) {
    const { recent, previous } = splitIntoWindows(delays);
    result.set(customerId, computeTrendFromDelays(recent, previous));
  }
  return result;
}
