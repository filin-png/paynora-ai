/**
 * Cookie-consent foundation (Phase 15A). See
 * docs/privacy-data-inventory.md#technical-data for the complete,
 * verified list of cookies this application actually sets today — as of
 * this phase, that list is exactly two: the Auth.js session cookie
 * (strictly necessary) and `paynora_locale` (functional preference).
 * Neither requires consent under a typical strictly-necessary-cookie
 * exemption. No analytics cookie exists (PostHog is called server-side
 * only, never a browser script), so nothing analytics-related is
 * currently gated by this mechanism at the cookie/browser-storage layer
 * — the real analytics on/off control is `Organization.analyticsEnabled`
 * (Settings -> Privacy). This module exists so a real consent record and
 * a real, working Accept/Reject control exist as a foundation, honestly
 * documented rather than wired to a technical gate that doesn't apply
 * yet — see docs/privacy-policy.md#cookies for the user-facing framing.
 */
export const COOKIE_CONSENT_COOKIE = "paynora_cookie_consent";
export const COOKIE_CONSENT_VALUES = ["accepted", "rejected"] as const;
export type CookieConsentValue = (typeof COOKIE_CONSENT_VALUES)[number];

export function isCookieConsentValue(value: string | undefined | null): value is CookieConsentValue {
  return (COOKIE_CONSENT_VALUES as readonly string[]).includes(value ?? "");
}
