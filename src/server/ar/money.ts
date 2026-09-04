import { z } from "zod";
import type { Currency } from "./currency";

/**
 * Money is stored and computed exclusively as integer minor units (e.g.
 * kopecks, cents) — never as a JS float, and never as a plain `number` at
 * all, because a `number` can only represent integers exactly up to
 * 2^53 - 1. Amounts are `bigint`, backed by a Postgres BIGINT column
 * (int8, ±9,223,372,036,854,775,807 minor units — about 92 quadrillion in
 * major currency units). `amountMinorSchema`'s max mirrors that column's
 * actual ceiling; it is a storage limit, not a business one — see
 * docs/accounts-receivable.md#money-representation for the full rationale
 * and why an earlier Int32 (2,147,483,647 minor units, ~21.4M major units)
 * design was rejected as an artificial cap unacceptable for a commercial
 * B2B product.
 *
 * `bigint` never crosses a Server Action / Client Component boundary in
 * this codebase — Next.js's RSC serialization for `bigint` isn't something
 * to rely on either way, so the boundary only ever carries strings: a
 * formatted display string (formatMoney) going out, or a raw form string
 * (parsed by parseAmountInput) coming in. Arithmetic and comparisons stay
 * in `bigint` on the server the entire time in between.
 */
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export const amountMinorSchema = z
  .bigint()
  .positive("Amount must be greater than zero")
  .max(POSTGRES_BIGINT_MAX, "Amount is too large to store");

const MINOR_UNITS_PER_MAJOR = 100n;

/**
 * Convenience for constructing amounts from a small, exactly-representable
 * JS number (test fixtures, known constants) — NOT for parsing user input,
 * which must go through parseAmountInput to avoid floating point entirely.
 */
export function majorToMinor(majorAmount: number): bigint {
  return BigInt(Math.round(majorAmount * 100)) as bigint;
}

const DECIMAL_INPUT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a form-submitted decimal amount ("1500", "1500.5", "1500.50")
 * into minor units using exact string/BigInt arithmetic — no floating
 * point step, so this is safe for arbitrarily large amounts. This is the
 * only place a user-supplied amount string enters the system; service
 * functions and tests work with the resulting bigint directly.
 */
export function parseAmountInput(raw: string): bigint {
  const trimmed = raw.trim();
  const match = DECIMAL_INPUT_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error("Amount must be a number with at most 2 decimal places");
  }
  const [, wholePart, fractionPartRaw] = match;
  const fractionPart = (fractionPartRaw ?? "").padEnd(2, "0");
  return BigInt(wholePart) * MINOR_UNITS_PER_MAJOR + BigInt(fractionPart);
}

/**
 * The inverse of parseAmountInput — a plain decimal string ("1500.50"),
 * no currency symbol or thousands separator, via exact string/BigInt
 * arithmetic (never a float step). For contexts where formatMoney's
 * locale-formatted display string is wrong (CSV export, where a
 * spreadsheet should read the column as a plain number) — see
 * src/server/ar/export.ts.
 */
export function minorToMajorString(amountMinor: bigint): string {
  const negative = amountMinor < 0n;
  const magnitude = negative ? -amountMinor : amountMinor;
  const whole = magnitude / MINOR_UNITS_PER_MAJOR;
  const fraction = magnitude % MINOR_UNITS_PER_MAJOR;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`;
}

const MAX_SAFE_FORMATTABLE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

const currencyFormatters = new Map<Currency, Intl.NumberFormat>();

function getFormatter(currency: Currency): Intl.NumberFormat {
  let formatter = currencyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    currencyFormatters.set(currency, formatter);
  }
  return formatter;
}

/**
 * Formats a bigint minor-unit amount for display. Converts to `Number`
 * only here, only for formatting, and only after an explicit range check —
 * amounts this large are not a realistic Phase 2 scenario, but the
 * conversion is guarded rather than silently risking precision loss (per
 * the project's money-handling requirements), consistent with never
 * treating a financial amount's `Number` form as authoritative.
 */
export function formatMoney(amountMinor: bigint, currency: Currency): string {
  const magnitude = amountMinor < 0n ? -amountMinor : amountMinor;
  if (magnitude > MAX_SAFE_FORMATTABLE_MINOR) {
    throw new Error(
      "Amount exceeds what can be safely formatted as a JS number — see docs/accounts-receivable.md#money-representation",
    );
  }
  return getFormatter(currency).format(Number(amountMinor) / 100);
}
