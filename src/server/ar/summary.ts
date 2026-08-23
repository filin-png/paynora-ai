import { prisma } from "@/server/db/client";
import type { Currency } from "./currency";
import { daysBetween, getBusinessToday, toDateOnlyString } from "./dates";
import { listInvoicesWithFinancials } from "./invoices";

export type CurrencyArSummary = {
  currency: Currency;
  totalOutstandingMinor: bigint;
  totalOverdueMinor: bigint;
  openInvoiceCount: number;
  overdueInvoiceCount: number;
};

/**
 * Grouped by currency, deliberately never summed across currencies — a
 * combined "total outstanding" mixing RUB and USD would be a meaningless,
 * silently wrong number. See docs/accounts-receivable.md#currency-model.
 */
export async function getOrganizationArSummary(
  organizationId: string,
): Promise<CurrencyArSummary[]> {
  const invoicesWithFinancials = await listInvoicesWithFinancials(organizationId, "all");

  const byCurrency = new Map<Currency, CurrencyArSummary>();
  for (const { invoice, financials } of invoicesWithFinancials) {
    if (invoice.status !== "OPEN" || financials.isPaid) continue;

    const currency = invoice.currency as Currency;
    const existing = byCurrency.get(currency) ?? {
      currency,
      totalOutstandingMinor: 0n,
      totalOverdueMinor: 0n,
      openInvoiceCount: 0,
      overdueInvoiceCount: 0,
    };

    existing.totalOutstandingMinor += financials.outstandingMinor;
    existing.openInvoiceCount += 1;
    if (financials.isOverdue) {
      existing.totalOverdueMinor += financials.outstandingMinor;
      existing.overdueInvoiceCount += 1;
    }

    byCurrency.set(currency, existing);
  }

  return Array.from(byCurrency.values()).sort((a, b) => a.currency.localeCompare(b.currency));
}

const ATTENTION_LOOKAHEAD_DAYS = 7;

export type InvoiceRequiringAttention = Awaited<
  ReturnType<typeof listInvoicesWithFinancials>
>[number] & { reason: "overdue" | "due-soon" };

/**
 * Deterministic, non-AI definition of "needs attention": overdue open
 * invoices, plus open invoices due within the next 7 days — both still
 * outstanding. Overdue sorts first (most overdue first), then soonest due.
 * Phase 3 may layer AI risk scoring on top of this; it does not replace it.
 */
export async function getInvoicesRequiringAttention(
  organizationId: string,
): Promise<InvoiceRequiringAttention[]> {
  const today = getBusinessToday();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() + ATTENTION_LOOKAHEAD_DAYS);
  const cutoffStr = toDateOnlyString(cutoff);

  const invoicesWithFinancials = await listInvoicesWithFinancials(organizationId, "all");

  const attention: InvoiceRequiringAttention[] = [];
  for (const entry of invoicesWithFinancials) {
    const { invoice, financials } = entry;
    if (invoice.status !== "OPEN" || financials.isPaid) continue;

    if (financials.isOverdue) {
      attention.push({ ...entry, reason: "overdue" });
    } else if (toDateOnlyString(invoice.dueDate) <= cutoffStr && toDateOnlyString(invoice.dueDate) >= today) {
      attention.push({ ...entry, reason: "due-soon" });
    }
  }

  return attention.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === "overdue" ? -1 : 1;
    return toDateOnlyString(a.invoice.dueDate).localeCompare(toDateOnlyString(b.invoice.dueDate));
  });
}

const RECENT_PAYMENTS_LIMIT = 10;

export async function listRecentPayments(organizationId: string, take = RECENT_PAYMENTS_LIMIT) {
  return prisma.payment.findMany({
    where: { organizationId },
    include: { invoice: { include: { customer: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export type CustomerReceivablesSummary = {
  openInvoiceCount: number;
  outstandingByCurrency: { currency: Currency; outstandingMinor: bigint }[];
};

/**
 * Per-customer outstanding exposure for the customer list page — one
 * organization-wide query (`listInvoicesWithFinancials`, already used
 * elsewhere), grouped by customer in memory. Not a per-customer query:
 * calling that once per row would be an N+1 pattern on a page that can
 * list many customers. Never sums across currencies, same rule as
 * `getOrganizationArSummary`.
 */
export async function getCustomerReceivablesSummaries(
  organizationId: string,
): Promise<Map<string, CustomerReceivablesSummary>> {
  const openInvoices = await listInvoicesWithFinancials(organizationId, "open");

  const byCustomer = new Map<string, Map<Currency, bigint>>();
  const openCounts = new Map<string, number>();

  for (const { invoice, financials } of openInvoices) {
    if (financials.isPaid) continue;
    const currency = invoice.currency as Currency;
    const currencyTotals = byCustomer.get(invoice.customerId) ?? new Map<Currency, bigint>();
    currencyTotals.set(currency, (currencyTotals.get(currency) ?? 0n) + financials.outstandingMinor);
    byCustomer.set(invoice.customerId, currencyTotals);
    openCounts.set(invoice.customerId, (openCounts.get(invoice.customerId) ?? 0) + 1);
  }

  const result = new Map<string, CustomerReceivablesSummary>();
  for (const [customerId, currencyTotals] of byCustomer) {
    result.set(customerId, {
      openInvoiceCount: openCounts.get(customerId) ?? 0,
      outstandingByCurrency: Array.from(currencyTotals.entries())
        .map(([currency, outstandingMinor]) => ({ currency, outstandingMinor }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    });
  }
  return result;
}

export type AgingBucket = {
  label: string;
  minDays: number;
  maxDays: number | null;
  outstandingMinor: bigint;
  invoiceCount: number;
};

const AGING_BUCKET_DEFS: Array<{ label: string; minDays: number; maxDays: number | null }> = [
  { label: "1-30 days", minDays: 1, maxDays: 30 },
  { label: "31-60 days", minDays: 31, maxDays: 60 },
  { label: "61-90 days", minDays: 61, maxDays: 90 },
  { label: "90+ days", minDays: 91, maxDays: null },
];

/**
 * Buckets currently-overdue outstanding balance by days overdue, for one
 * currency (never summed across currencies — same rule as
 * `getOrganizationArSummary`). Reuses `listInvoicesWithFinancials`'s
 * existing overdue definition rather than recomputing it, so the Overview
 * aging chart can never disagree with the invoice list's own "overdue"
 * filter.
 */
export async function getAgingSummary(
  organizationId: string,
  currency: Currency,
): Promise<{ buckets: AgingBucket[]; totalOverdueMinor: bigint }> {
  const overdueInvoices = await listInvoicesWithFinancials(organizationId, "overdue");
  const today = getBusinessToday();

  const buckets: AgingBucket[] = AGING_BUCKET_DEFS.map((def) => ({
    ...def,
    outstandingMinor: 0n,
    invoiceCount: 0,
  }));
  let totalOverdueMinor = 0n;

  for (const { invoice, financials } of overdueInvoices) {
    if ((invoice.currency as Currency) !== currency) continue;
    const overdueDays = daysBetween(toDateOnlyString(invoice.dueDate), today);
    const bucket =
      buckets.find((b) => overdueDays >= b.minDays && (b.maxDays === null || overdueDays <= b.maxDays)) ??
      buckets[buckets.length - 1];
    bucket.outstandingMinor += financials.outstandingMinor;
    bucket.invoiceCount += 1;
    totalOverdueMinor += financials.outstandingMinor;
  }

  return { buckets, totalOverdueMinor };
}

export type ReceivablesTrendPoint = {
  date: string;
  outstandingMinor: bigint;
  collectedMinor: bigint;
};

const TREND_WINDOW_DAYS = 14;

/**
 * Reconstructs a real (never fabricated) trend line from the ledger:
 * cumulative issued-minus-collected outstanding balance, and cumulative
 * collected, per day over the trailing 14 days — for one currency. Reads
 * raw invoice/payment rows directly (not `listInvoicesWithFinancials`,
 * which only answers "as of today") because a trend needs the balance as
 * of each of several past days. Cancelled invoices are excluded, matching
 * every other AR aggregate's treatment of cancellation as "never a real
 * receivable".
 */
export async function getReceivablesTrend(
  organizationId: string,
  currency: Currency,
): Promise<ReceivablesTrendPoint[]> {
  const today = getBusinessToday();
  const start = new Date(`${today}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - (TREND_WINDOW_DAYS - 1));

  const [invoices, payments] = await Promise.all([
    prisma.invoice.findMany({
      where: { organizationId, currency, status: "OPEN" },
      select: { amountMinor: true, issueDate: true },
    }),
    prisma.payment.findMany({
      where: { organizationId, invoice: { currency } },
      select: { amountMinor: true, paidAt: true },
    }),
  ]);

  const points: ReceivablesTrendPoint[] = [];
  const cursor = new Date(start);
  for (let i = 0; i < TREND_WINDOW_DAYS; i += 1) {
    const date = toDateOnlyString(cursor);
    let issuedMinor = 0n;
    for (const invoice of invoices) {
      if (toDateOnlyString(invoice.issueDate) <= date) issuedMinor += invoice.amountMinor;
    }
    let collectedMinor = 0n;
    for (const payment of payments) {
      if (toDateOnlyString(payment.paidAt) <= date) collectedMinor += payment.amountMinor;
    }
    const outstandingMinor = issuedMinor - collectedMinor;
    points.push({ date, outstandingMinor: outstandingMinor < 0n ? 0n : outstandingMinor, collectedMinor });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return points;
}
