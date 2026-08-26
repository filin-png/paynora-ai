import { en, type Dictionary } from "./dictionaries/en";
import { ru } from "./dictionaries/ru";
import type { Locale } from "./config";

export type { Dictionary };
export { SUPPORTED_LOCALES, DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale, type Locale } from "./config";

const DICTIONARIES: Record<Locale, Dictionary> = { en, ru };

/** Pure — never reads a cookie or does I/O itself; see get-locale.ts for the request-scoped lookup. */
export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}
