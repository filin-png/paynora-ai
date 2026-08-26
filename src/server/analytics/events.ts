import { resolveAnalyticsProvider } from "./service";
import type { AnalyticsEvent, AnalyticsProvider } from "./types";

/**
 * The one call site every domain caller uses to track a product event —
 * see docs/production-integrations.md#analytics for the full event list.
 * Deliberately an allowlist of event names (not free-text), so a typo or a
 * copy-pasted internal identifier can never silently become a new event.
 */
export const ANALYTICS_EVENTS = [
  "user_signed_up",
  "user_signed_in",
  "invoice_created",
  "invoice_sent",
  "payment_recorded",
  "wallet_connected",
  "crypto_payment_requested",
  "crypto_transaction_detected",
  "crypto_transaction_confirmed",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

const SENSITIVE_KEY_PATTERN = /secret|key|token|password|private|seed|mnemonic|auth|ssn|iban|card|signature/i;

/**
 * Defense-in-depth redaction: even though every call site below only ever
 * passes small, deliberately chosen properties, a property whose *name*
 * looks sensitive is dropped here too, never transmitted — see the phase
 * brief's explicit ban on private keys/secrets/full PII/auth tokens/raw
 * financial documents reaching an analytics vendor.
 */
function sanitizeProperties(
  properties: AnalyticsEvent["properties"],
): AnalyticsEvent["properties"] {
  if (!properties) return undefined;
  const safe: NonNullable<AnalyticsEvent["properties"]> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * Fire-and-forget, never throws, never awaited by callers for correctness
 * (a slow/broken analytics vendor must never delay or fail a real
 * financial or auth action) — errors are swallowed here as a second layer
 * on top of each provider's own never-throw contract.
 */
export function trackEvent(
  name: AnalyticsEventName,
  input: { organizationId?: string; userId?: string; properties?: AnalyticsEvent["properties"] } = {},
  provider: AnalyticsProvider = resolveAnalyticsProvider(),
): void {
  void provider
    .capture({
      name,
      organizationId: input.organizationId,
      userId: input.userId,
      properties: sanitizeProperties(input.properties),
    })
    .catch(() => {
      // Swallowed — see the function doc comment above.
    });
}
