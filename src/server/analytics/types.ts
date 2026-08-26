/**
 * AnalyticsProvider — vendor-neutral product-analytics boundary, mirroring
 * BillingProvider/WalletProvider's discipline (src/server/billing/types.ts,
 * src/server/wallet/provider-types.ts). An adapter only ever transmits an
 * already-sanitized event; it never decides what's safe to send — that's
 * `trackEvent`'s job (src/server/analytics/events.ts), the one call site
 * every domain caller uses.
 */
export type AnalyticsEvent = {
  name: string;
  /** Distinguishes the acting organization without embedding PII — same tenant-scoping discipline as every other domain call. */
  organizationId?: string;
  userId?: string;
  /** Flat, JSON-serializable, non-sensitive properties only — see trackEvent's redaction discipline. */
  properties?: Record<string, string | number | boolean | null>;
};

export interface AnalyticsProvider {
  readonly name: string;
  /** Must never throw — a broken analytics vendor must never break a real user action. Adapters catch their own network/HTTP errors internally. */
  capture(event: AnalyticsEvent): Promise<void>;
}
