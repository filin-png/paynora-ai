import Papa from "papaparse";

import { MAX_IMPORT_ROWS } from "../limits";

/**
 * The one place CSV-specific parsing lives — the generic (header-name ->
 * value) row shape this returns is what every entity-specific normalizer
 * in this directory (`customers.ts`, `invoices.ts`) consumes. Nothing
 * here knows what a "customer" or "invoice" is; see
 * docs/data-ingestion.md#architecture.
 */
export type CsvRow = {
  /** 1-based position among data rows, header excluded — used only for error messages. */
  rowNumber: number;
  fields: Record<string, string>;
  /** Set when this specific row is malformed (wrong field count, unterminated quote) — its `fields` are best-effort and must not be trusted if this is set. */
  parseError?: string;
};

export type CsvParseResult = { ok: true; headers: string[]; rows: CsvRow[] } | { ok: false; reason: string };

/**
 * Parses UTF-8 CSV text with a header row. Distinguishes two failure
 * classes deliberately: a *structural* problem (no header row, or more
 * rows than PAYNORA will process in one import) rejects the whole file
 * before any row is even looked at — see `MAX_IMPORT_ROWS`. A malformed
 * *individual* row (Papa Parse's field-count/quote errors) does not reject
 * the file; it's attached to that one `CsvRow` so the entity-specific
 * normalizer can turn it into a row-level import failure, exactly like an
 * invalid email or a bad amount — a bad file must never produce a
 * mysterious generic error for rows that were otherwise fine.
 */
export function parseCsvText(text: string): CsvParseResult {
  if (text.trim().length === 0) {
    return { ok: false, reason: "The file is empty." };
  }

  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  const headers = (result.meta.fields ?? []).map((header) => header.trim()).filter((header) => header.length > 0);
  if (headers.length === 0) {
    return { ok: false, reason: "The file has no recognizable header row." };
  }

  if (result.data.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      reason: `This file has ${result.data.length} rows, which is more than the ${MAX_IMPORT_ROWS}-row limit per import. Split it into smaller files.`,
    };
  }

  const rowLevelErrors = new Map<number, string>();
  for (const error of result.errors) {
    // Papa's `row` is a 0-based index over the data rows (header already excluded).
    if (typeof error.row === "number" && !rowLevelErrors.has(error.row)) {
      rowLevelErrors.set(error.row, error.message);
    }
  }

  const rows: CsvRow[] = result.data.map((fields, index) => ({
    rowNumber: index + 1,
    fields,
    parseError: rowLevelErrors.get(index),
  }));

  return { ok: true, headers, rows };
}
