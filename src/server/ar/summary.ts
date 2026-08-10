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
