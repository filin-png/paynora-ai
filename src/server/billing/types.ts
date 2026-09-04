/**
 * BillingProvider is a payment-processor abstraction for PAYNORA's own
 * subscription billing (what a PAYNORA customer organization pays PAYNORA
 * to use the product) — a distinct domain concept from AR/collections,
 * which is what a PAYNORA customer organization's *own* customers pay
 * *them* on an Invoice. Nothing in this file touches Invoice/Payment
 * (src/server/ar/*); see docs/integration-architecture.md#billing.
 *
 * Phase 6 ships types + a recognized-but-unimplemented Stripe/YooKassa
 * selection only — no real SDK call, no Prisma schema (PAYNORA's own
 * subscription state has no table yet; adding one with nothing reading or
 * writing it would be dead code, see docs/provider-strategy.md). The
 * actual subscription domain — plan mapping, applying a verified webhook
 * event to durable state — is Phase 7 "Monetization" work.
 */
export type BillingProviderName = "stripe" | "yookassa";

/** Opaque, provider-assigned identifier for a billing customer — never a PAYNORA organization id. */
export type BillingCustomerId = string & { readonly __brand: "BillingCustomerId" };

/** Opaque, provider-assigned identifier for a subscription. */
export type BillingSubscriptionId = string & { readonly __brand: "BillingSubscriptionId" };

/**
 * Vendor subscription statuses normalized to one shared vocabulary — Stripe
 * and YooKassa each have their own status strings; domain code (once it
 * exists) should only ever see this set, never a raw vendor string.
 */
export type BillingSubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "unpaid";

/**
 * Identifies a single webhook delivery. This — not anything derived from
 * the request — is the idempotency boundary a future billing domain must
 * check before applying an event: providers retry webhook delivery, so the
 * same `eventId` can arrive more than once. See
 * docs/integration-architecture.md#billing.
 */
export type WebhookEventIdentity = {
  provider: BillingProviderName;
  eventId: string;
};

/** A webhook event, verified and reduced to the fields a future billing domain needs — never the raw vendor payload. */
export type NormalizedSubscriptionEvent = {
  eventIdentity: WebhookEventIdentity;
  customerId: BillingCustomerId;
  subscriptionId: BillingSubscriptionId;
  status: BillingSubscriptionStatus;
  /** Provider-specific plan/price id. Mapping this to a PAYNORA plan is future domain logic, not this layer's job. */
  planId?: string;
  /**
   * What this delivery reports as charged, in PAYNORA's own bigint-minor-units
   * convention (see src/server/ar/money.ts) — not every subscription-lifecycle
   * event carries a charge (e.g. cancellation), so both are optional and must
   * be set together or not at all. This is the vendor's own reported amount,
   * never a value PAYNORA computes or assumes from its plan catalog.
   */
  amountMinor?: bigint;
  currency?: string;
};

/**
 * Implemented by every concrete billing vendor adapter
 * (src/server/billing/providers/*.ts). Deliberately narrow: verification
 * and normalization only. A BillingProvider must never itself change
 * Invoice/Payment/subscription state — it hands a verified, normalized
 * event back to its caller, which applies domain rules (including its own
 * idempotency check against `eventIdentity.eventId`). This is what "must
 * never directly change financial state without a verified webhook/domain
 * flow" means concretely — see docs/integration-architecture.md#billing.
 */
export interface BillingProvider {
  readonly name: string;
  /**
   * Verifies a webhook delivery's authenticity (e.g. Stripe's
   * `Stripe-Signature` header, YooKassa's IP allowlist + notification
   * shape) and parses it into a `NormalizedSubscriptionEvent`. Must throw
   * — never return a best-guess result — when the signature/authenticity
   * check fails; a forged webhook must never reach domain code labeled as
   * legitimate.
   */
  verifyAndParseWebhook(rawBody: string, signatureHeader: string): NormalizedSubscriptionEvent;
}
