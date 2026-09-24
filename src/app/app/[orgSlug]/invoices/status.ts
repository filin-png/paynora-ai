import type { Dictionary } from "@/lib/i18n";
import type { InvoiceFinancials } from "@/server/ar/invoices";

export type InvoiceStatusTone = "neutral" | "success" | "warning" | "danger";

type StatusLabels = Pick<
  Dictionary["invoices"],
  "statusCancelled" | "statusPaid" | "statusOverdue" | "statusPartiallyPaid" | "statusOpen"
>;

// Default for callers not yet migrated to pass a locale-aware `labels` —
// see docs/production-integrations.md#internationalization-status.
const EN_STATUS_LABELS: StatusLabels = {
  statusCancelled: "Cancelled",
  statusPaid: "Paid",
  statusOverdue: "Overdue",
  statusPartiallyPaid: "Partially paid",
  statusOpen: "Open",
};

/**
 * UI-only presentation of the financial state computeInvoiceFinancials
 * already derived — no status logic lives here, just labels/colors.
 */
export function getInvoiceStatusDisplay(
  invoice: { status: "OPEN" | "CANCELLED" },
  financials: InvoiceFinancials,
  labels: StatusLabels = EN_STATUS_LABELS,
): { label: string; tone: InvoiceStatusTone } {
  if (invoice.status === "CANCELLED") return { label: labels.statusCancelled, tone: "neutral" };
  if (financials.isPaid) return { label: labels.statusPaid, tone: "success" };
  if (financials.isOverdue) return { label: labels.statusOverdue, tone: "danger" };
  if (financials.isPartiallyPaid) return { label: labels.statusPartiallyPaid, tone: "warning" };
  return { label: labels.statusOpen, tone: "neutral" };
}
