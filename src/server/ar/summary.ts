import { prisma } from "@/server/db/client";
import type { Currency } from "./currency";
import { getBusinessToday, toDateOnlyString } from "./dates";
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
