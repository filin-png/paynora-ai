import { cookies } from "next/headers";

import { COOKIE_CONSENT_COOKIE, isCookieConsentValue, type CookieConsentValue } from "./cookie-consent";

/** Server-only — mirrors src/lib/i18n/get-locale.ts's shape exactly. Never throws; an unset/malformed cookie reads as "unset". */
export async function getCookieConsent(): Promise<CookieConsentValue | "unset"> {
  const store = await cookies();
  const value = store.get(COOKIE_CONSENT_COOKIE)?.value;
  return isCookieConsentValue(value) ? value : "unset";
}
