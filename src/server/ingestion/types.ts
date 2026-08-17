/**
 * The source-neutral boundary this whole module exists to define — see
 * `docs/data-ingestion.md`. A `NormalizedCustomerRecord`/
 * `NormalizedInvoiceRecord` carries the same canonical, string-keyed
 * fields no matter what produced it: today that's a CSV row (parsed and
 * column-name-mapped in `csv/`), but a future bank/accounting/ERP adapter
 * would produce the exact same shape and hand it to the exact same
 * `importCustomers`/`importInvoices` functions in `customers.ts`/
 * `invoices.ts` — those two files never know or care that CSV exists.
 *
 * Deliberately untyped/unconverted at this boundary (amounts and dates
 * are still raw strings) — conversion to PAYNORA's actual domain types
 * (bigint minor units, `Date`) happens once, in the validation step,
 * reusing the exact same schemas (`invoiceInputSchema`,
 * `customerInputSchema`) the manual entry forms already use. That keeps
 * every source adapter simple (map columns to field names, done) and
 * keeps exactly one implementation of "is this a valid invoice" for the
 * whole app to trust.
 */
export type NormalizedCustomerRecord = {
  /** 1-based position in the source (CSV: data row number, header excluded) — for error messages only. */
  sourceRow: number;
  name: string;
  email: string;
  phone: string;
  /** Set when the source adapter couldn't cleanly produce this record at all (e.g. a malformed CSV row) — the record's other fields are best-effort and must not be trusted if this is set. */
  sourceError?: string;
};

export type NormalizedInvoiceRecord = {
  sourceRow: number;
  invoiceNumber: string;
  /** The deterministic customer-matching key — see docs/data-ingestion.md#customer-matching. */
  customerEmail: string;
  /** Raw decimal string (e.g. "1500.25") — converted via the same exact-arithmetic parser the payment form uses, never a float. */
  amount: string;
  currency: string;
  /** Raw "YYYY-MM-DD" — validated by the same schema the invoice form uses. */
  issueDate: string;
  dueDate: string;
  sourceError?: string;
};

export type ImportRowStatus = "created" | "skipped" | "failed";

export type ImportRowResult = {
  sourceRow: number;
  status: ImportRowStatus;
  message: string;
  /** Which field the error relates to, when applicable — lets the UI highlight it. */
  field?: string;
};

export type ImportSummary = {
  totalRows: number;
  created: number;
  skipped: number;
  failed: number;
  rows: ImportRowResult[];
};

/**
 * The outcome of one import attempt. `rejected` means nothing was
 * attempted at all — a structural problem (bad headers, empty file, too
 * many rows) that makes the whole file unsafe to process row-by-row. Once
 * an import reaches `completed`, every row got an explicit outcome; there
 * is no third "some rows were silently never looked at" case.
 */
export type ImportOutcome = { kind: "rejected"; reason: string } | { kind: "completed"; summary: ImportSummary };

export function summarizeRows(totalRows: number, rows: ImportRowResult[]): ImportSummary {
  return {
    totalRows,
    created: rows.filter((r) => r.status === "created").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    failed: rows.filter((r) => r.status === "failed").length,
    rows,
  };
}
