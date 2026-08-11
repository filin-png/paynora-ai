import type { InvoiceFinancials } from "@/server/ar/invoices";

export type InvoiceStatusTone = "neutral" | "success" | "warning" | "danger";

/**
 * UI-only presentation of the financial state computeInvoiceFinancials
 * already derived — no status logic lives here, just labels/colors.
 */
export function getInvoiceStatusDisplay(
  invoice: { status: "OPEN" | "CANCELLED" },
  financials: InvoiceFinancials,
): { label: string; tone: InvoiceStatusTone } {
  if (invoice.status === "CANCELLED") return { label: "Cancelled", tone: "neutral" };
  if (financials.isPaid) return { label: "Paid", tone: "success" };
  if (financials.isOverdue) return { label: "Overdue", tone: "danger" };
  if (financials.isPartiallyPaid) return { label: "Partially paid", tone: "warning" };
  return { label: "Open", tone: "neutral" };
}
