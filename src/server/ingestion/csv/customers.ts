import type { NormalizedCustomerRecord } from "../types";
import { parseCsvText } from "./parse";

/**
 * Documented in the UI verbatim — see `docs/data-ingestion.md#customer-csv-format`.
 * `email` is required here even though `Customer.email` is optional in
 * the general AR domain (manual customer creation is unaffected — see
 * `customerInputSchema` in `src/server/ar/customers.ts`, unchanged). CSV
 * import specifically needs a deterministic per-row identity to dedupe
 * against, and normalized email is the only one available without a
 * customer-identity redesign — an emailless row can never be matched
 * against anything on re-import, which silently breaks idempotency.
 */
export const CUSTOMER_CSV_REQUIRED_HEADERS = ["name", "email"] as const;
export const CUSTOMER_CSV_OPTIONAL_HEADERS = ["phone"] as const;
export const CUSTOMER_CSV_HEADERS = [...CUSTOMER_CSV_REQUIRED_HEADERS, ...CUSTOMER_CSV_OPTIONAL_HEADERS];

export type CustomerCsvResult = { ok: true; records: NormalizedCustomerRecord[] } | { ok: false; reason: string };

/**
 * The only place CSV column names are mapped to `NormalizedCustomerRecord`
 * field names — deliberately by header name, not column position, so
 * column order in the uploaded file never matters and a future non-CSV
 * source never needs to "pretend" to have columns at all.
 */
export function parseCustomerCsv(text: string): CustomerCsvResult {
  const parsed = parseCsvText(text);
  if (!parsed.ok) return parsed;

  const missingHeaders = CUSTOMER_CSV_REQUIRED_HEADERS.filter((header) => !parsed.headers.includes(header));
  if (missingHeaders.length > 0) {
    return {
      ok: false,
      reason: `Missing required column(s): ${missingHeaders.join(", ")}. Expected headers: ${CUSTOMER_CSV_HEADERS.join(", ")}.`,
    };
  }

  const records: NormalizedCustomerRecord[] = parsed.rows.map((row) => ({
    sourceRow: row.rowNumber,
    name: (row.fields.name ?? "").trim(),
    email: (row.fields.email ?? "").trim(),
    phone: (row.fields.phone ?? "").trim(),
    sourceError: row.parseError,
  }));

  return { ok: true, records };
}
