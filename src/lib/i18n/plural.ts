import type { Locale } from "./config";

/**
 * Picks the right noun form for a count — English only distinguishes
 * one/other, but Russian has three forms (1 счёт / 2 счёта / 5 счетов,
 * and it recurs for every compound like 21/22/25) that don't map onto
 * English's singular/plural at all. `few`/`many` collapse to the same
 * string for English callers; Russian callers give three distinct ones.
 */
export function pluralForm(n: number, locale: Locale, forms: { one: string; few: string; many: string }): string {
  if (locale === "ru") {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms.one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms.few;
    return forms.many;
  }
  return n === 1 ? forms.one : forms.many;
}
