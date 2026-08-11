import { z } from "zod";

/**
 * Allowlisted, not free-text: a typo'd currency code would silently break
 * every AR calculation that groups by currency. Adding a currency later is
 * a one-line change here, not a migration — see docs/accounts-receivable.md.
 */
export const SUPPORTED_CURRENCIES = ["RUB", "USD", "EUR"] as const;

export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export const currencySchema = z.enum(SUPPORTED_CURRENCIES);

export function isSupportedCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}
