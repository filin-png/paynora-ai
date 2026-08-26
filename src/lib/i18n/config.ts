/**
 * i18n foundation (Phase 14) — see docs/production-integrations.md#internationalization-status
 * for exactly which parts of the UI this is wired into today (app-shell
 * navigation, the landing page's nav/hero, Settings -> Integrations
 * category labels) versus not yet translated (everything else). This
 * module is deliberately small: a real, working resource-dictionary
 * architecture, scoped honestly rather than a full sweep of every screen.
 */
export const SUPPORTED_LOCALES = ["en", "ru"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Persists the chosen locale across requests — see src/lib/i18n/actions.ts. */
export const LOCALE_COOKIE = "paynora_locale";

export function isSupportedLocale(value: string | undefined | null): value is Locale {
  return SUPPORTED_LOCALES.includes(value as Locale);
}
