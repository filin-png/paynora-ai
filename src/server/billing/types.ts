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
 * Opaque, provider-assigned identifier for a single payment/transaction
 * (Phase 20). Not every provider has a native "subscription" object —
 * YooKassa's model is payment-based, not subscription-based (recurring
 * charges are done by saving a payment method and creating new one-off
 * payments against it, not by a Stripe-style subscription resource) — see
 * docs/billing-provider.md#yookassa-has-no-native-subscription-object.
 * This is the id `src/server/billing/checkout.ts`'s `BillingCheckoutSession.externalPaymentId`
 * is keyed on, and the authoritative lookup key
 * `applySubscriptionWebhookEvent` uses for a checkout-driven event.
 */
export type BillingPaymentId = string & { readonly __brand: "BillingPaymentId" };

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
  /**
   * Deliberately `string`, not `BillingProviderName` — this flows straight
   * into `OrganizationSubscription.billingProvider` /
   * `SubscriptionPayment.provider` (both plain `String` columns, see
   * prisma/schema.prisma), and `createTestBillingProvider`
   * (src/server/billing/providers/test.ts) needs to stamp its own
   * `"test"` name here so tests exercise the real event-identity/dedup
   * path end-to-end, not a real vendor name it doesn't have.
   */
  provider: string;
  eventId: string;
};

/**
 * A webhook event, verified and reduced to the fields a future billing
 * domain needs — never the raw vendor payload.
 *
 * `customerId`/`subscriptionId` are optional (Phase 20): a payment-based
 * provider like YooKassa has neither a native "customer" nor "subscription"
 * object for a simple checkout flow — only `paymentId` is guaranteed.
 * `applySubscriptionWebhookEvent` resolves the organization by `paymentId`
 * first (via `BillingCheckoutSession`) when present, falling back to the
 * customerId/subscriptionId link only for providers/flows that have them.
 */
export type NormalizedSubscriptionEvent = {
  eventIdentity: WebhookEventIdentity;
  customerId?: BillingCustomerId;
  subscriptionId?: BillingSubscriptionId;
  /** The vendor's payment/transaction id (Phase 20) — see `BillingPaymentId`'s doc comment. */
  paymentId?: BillingPaymentId;
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
 * A real, provider-created checkout — the vendor now knows about this
 * payment attempt and has handed back a URL to redirect the payer to.
 * Never fabricated: `checkoutUrl` and `externalPaymentId` always come
 * from the vendor's own API response (Phase 20).
 */
export type CheckoutSession = {
  externalPaymentId: BillingPaymentId;
  checkoutUrl: string;
};

/**
 * What `createCheckout` needs to create one real, provider-side payment —
 * deliberately provider-neutral (no YooKassa/Stripe-specific field names).
 * `idempotencyKey` is passed straight through to the vendor's own
 * idempotency mechanism (e.g. YooKassa's `Idempotence-Key` header) so a
 * retried `createCheckout` call (a flaky network response, a duplicate
 * Server Action submission) can never create two real payments for the
 * same intent.
 */
export type CreateCheckoutInput = {
  amountMinor: bigint;
  currency: string;
  description: string;
  returnUrl: string;
  idempotencyKey: string;
  /**
   * Opaque key-value pairs echoed back verbatim on the vendor's payment
   * object and on every webhook event for it — used as a defense-in-depth
   * cross-check (never the sole authority; see
   * docs/billing-provider.md#checkout-session-security), not a substitute
   * for the `BillingCheckoutSession` row's own `externalPaymentId` lookup.
   */
  metadata: Record<string, string>;
};

/**
 * Context a real webhook authenticity check needs. Deliberately carries
 * both signature-header and source-IP shapes rather than picking one:
 * Stripe verifies via `Stripe-Signature`; YooKassa has no signature header
 * at all and is verified by source-IP allowlist instead (see
 * `docs/billing-provider.md#webhook-authenticity`) — a given adapter reads
 * only the field its own vendor's documented mechanism actually uses.
 */
export type WebhookVerificationContext = {
  signatureHeader?: string;
  sourceIp?: string;
};

/**
 * Implemented by every concrete billing vendor adapter
 * (src/server/billing/providers/*.ts). Deliberately narrow: checkout
 * creation, webhook verification, and normalization only. A
 * BillingProvider must never itself change Invoice/Payment/subscription
 * state — it hands a verified, normalized event back to its caller, which
 * applies domain rules (including its own idempotency check against
 * `eventIdentity.eventId`). This is what "must never directly change
 * financial state without a verified webhook/domain flow" means
 * concretely — see docs/integration-architecture.md#billing.
 */
export interface BillingProvider {
  readonly name: string;
  /**
   * Creates one real payment/checkout with the vendor and returns a URL
   * to redirect the payer to. Never called for anything but a genuine
   * upgrade request that already passed entitlement/rank checks — see
   * src/server/billing/checkout.ts#createCheckoutSession.
   */
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  /**
   * Verifies a webhook delivery's authenticity (e.g. Stripe's
   * `Stripe-Signature` header, YooKassa's IP allowlist + notification
   * shape) and parses it into a `NormalizedSubscriptionEvent`. Must throw
   * — never return a best-guess result — when the signature/authenticity
   * check fails; a forged webhook must never reach domain code labeled as
   * legitimate.
   */
  verifyAndParseWebhook(rawBody: string, context: WebhookVerificationContext): NormalizedSubscriptionEvent;
}
