import { cookies } from "next/headers";

import { DEFAULT_LOCALE, isSupportedLocale, LOCALE_COOKIE, type Locale } from "./config";

/**
 * Server-only — reads the locale cookie set by setLocaleAction. Falls
 * back to DEFAULT_LOCALE for a first-time visitor or an unrecognized
 * value; never throws. Call once per request (Server Component/layout),
 * then thread the resolved Locale/Dictionary down as props — mirrors how
 * requireOrganizationMembershipForPage resolves tenant context once at
 * the top of a request rather than re-deriving it in every component.
 */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}
