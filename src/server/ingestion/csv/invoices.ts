import type { NormalizedInvoiceRecord } from "../types";
import { parseCsvText } from "./parse";

/** Documented in the UI verbatim — see `docs/data-ingestion.md#invoice-csv-format`. */
export const INVOICE_CSV_REQUIRED_HEADERS = [
  "invoiceNumber",
  "customerEmail",
  "amount",
  "currency",
  "issueDate",
  "dueDate",
] as const;
export const INVOICE_CSV_HEADERS = INVOICE_CSV_REQUIRED_HEADERS;

export type InvoiceCsvResult = { ok: true; records: NormalizedInvoiceRecord[] } | { ok: false; reason: string };

/**
 * Same header-name-driven mapping as `csv/customers.ts` — see that file's
 * comment. `customerEmail` is PAYNORA's chosen deterministic
 * customer-matching key (no stable external customer identifier exists in
 * the current schema) — see docs/data-ingestion.md#customer-matching for
 * why, and its documented limitation (ambiguous when two customers in the
 * same org share an email, which the current `Customer` model doesn't
 * forbid).
 */
export function parseInvoiceCsv(text: string): InvoiceCsvResult {
  const parsed = parseCsvText(text);
  if (!parsed.ok) return parsed;

  const missingHeaders = INVOICE_CSV_REQUIRED_HEADERS.filter((header) => !parsed.headers.includes(header));
  if (missingHeaders.length > 0) {
    return {
      ok: false,
      reason: `Missing required column(s): ${missingHeaders.join(", ")}. Expected headers: ${INVOICE_CSV_HEADERS.join(", ")}.`,
    };
  }

  const records: NormalizedInvoiceRecord[] = parsed.rows.map((row) => ({
    sourceRow: row.rowNumber,
    invoiceNumber: (row.fields.invoiceNumber ?? "").trim(),
    customerEmail: (row.fields.customerEmail ?? "").trim(),
    amount: (row.fields.amount ?? "").trim(),
    currency: (row.fields.currency ?? "").trim(),
    issueDate: (row.fields.issueDate ?? "").trim(),
    dueDate: (row.fields.dueDate ?? "").trim(),
    sourceError: row.parseError,
  }));

  return { ok: true, records };
}
