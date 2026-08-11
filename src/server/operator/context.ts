import type { BusinessEvent } from "@prisma/client";

import type { Currency } from "@/server/ar/currency";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { getInvoiceWithFinancials } from "@/server/ar/invoices";
import { formatMoney } from "@/server/ar/money";

const MAX_CUSTOMER_NOTES_CHARS = 500;

/**
 * The deterministic, structured facts about one overdue invoice — the only
 * thing ever handed to the AI layer for this event type. Every field here
 * is read live from Phase 2 domain functions at build time, never from the
 * BusinessEvent's stored `data` snapshot (which is a point-in-time audit
 * record, not a live source of truth — see prisma/schema.prisma). The one
 * free-text field, `customerNotes`, is explicitly untrusted: it is
 * customer-authored data, not an instruction, and is never concatenated
 * into a prompt's `system` text — see src/server/operator/ai-context.ts
 * and docs/ai-architecture.md#prompt-injection.
 */
export type DeterministicInvoiceContext = {
  invoiceNumber: string;
  currency: Currency;
  outstandingAmount: string;
  dueDate: string;
  daysOverdue: number;
  customerName: string;
  customerNotes?: string;
};

export async function buildInvoiceOverdueContext(
  organizationId: string,
  event: Pick<BusinessEvent, "invoiceId">,
): Promise<DeterministicInvoiceContext> {
  if (!event.invoiceId) {
    throw new Error("INVOICE_OVERDUE event is missing an invoiceId");
  }

  const { invoice, financials } = await getInvoiceWithFinancials(organizationId, event.invoiceId);
  const currency = invoice.currency as Currency;
  const dueDateStr = toDateOnlyString(invoice.dueDate);

  return {
    invoiceNumber: invoice.number,
    currency,
    outstandingAmount: formatMoney(financials.outstandingMinor, currency),
    dueDate: dueDateStr,
    daysOverdue: daysBetween(dueDateStr, getBusinessToday()),
    customerName: invoice.customer.name,
    customerNotes: invoice.customer.notes
      ? invoice.customer.notes.slice(0, MAX_CUSTOMER_NOTES_CHARS)
      : undefined,
  };
}
