import type { Currency } from "./currency";
import { daysBetween, getBusinessToday, toDateOnlyString } from "./dates";
import { getInvoiceWithFinancials } from "./invoices";
import { formatMoney } from "./money";

const MAX_CUSTOMER_NOTES_CHARS = 500;

/**
 * The deterministic, structured facts about one invoice — the shared
 * building block for every reminder-adjacent feature that needs them:
 * Operator insight generation (src/server/operator/insights.ts) and
 * Communications draft generation (src/server/communications/draft.ts)
 * both call `buildDeterministicInvoiceContext` rather than each
 * recomputing these facts themselves. Every field is read live from
 * Phase 2 domain functions at build time — never from a stored snapshot,
 * which can go stale. The one free-text field, `customerNotes`, is
 * explicitly untrusted: it is customer-authored data, not an instruction,
 * and callers must never concatenate it into an AI system prompt — see
 * src/server/operator/ai-context.ts, src/server/communications/ai-context.ts,
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

/**
 * `today`, added in Phase 5, overrides "today" for the daysOverdue
 * calculation instead of the real server clock — see
 * getInvoiceWithFinancials's matching parameter in invoices.ts. Every
 * existing caller omits it and gets the previous behavior unchanged.
 */
export async function buildDeterministicInvoiceContext(
  organizationId: string,
  invoiceId: string,
  today: string = getBusinessToday(),
): Promise<DeterministicInvoiceContext> {
  const { invoice, financials } = await getInvoiceWithFinancials(organizationId, invoiceId, today);
  const currency = invoice.currency as Currency;
  const dueDateStr = toDateOnlyString(invoice.dueDate);

  return {
    invoiceNumber: invoice.number,
    currency,
    outstandingAmount: formatMoney(financials.outstandingMinor, currency),
    dueDate: dueDateStr,
    daysOverdue: daysBetween(dueDateStr, today),
    customerName: invoice.customer.name,
    customerNotes: invoice.customer.notes
      ? invoice.customer.notes.slice(0, MAX_CUSTOMER_NOTES_CHARS)
      : undefined,
  };
}
