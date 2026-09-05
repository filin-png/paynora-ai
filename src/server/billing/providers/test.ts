import { timingSafeEqual } from "node:crypto";

import { BillingWebhookVerificationError } from "../errors";
import type { BillingPaymentId, BillingProvider, CheckoutSession, CreateCheckoutInput, NormalizedSubscriptionEvent } from "../types";

export const TEST_BILLING_PROVIDER_NAME = "test";
const DEFAULT_TEST_SIGNATURE = "test-billing-signature";

/** Constant-time compare — same technique as src/server/wallet/providers/fake.ts's safeEqual. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type TestBillingEvent = {
  eventId: string;
  paymentId?: string;
  customerId?: string;
  subscriptionId?: string;
  status: NormalizedSubscriptionEvent["status"];
  planId?: string;
  amountMinor?: bigint;
  currency?: string;
};

/** The one place a TestBillingEvent is turned into the "raw body" a webhook route would actually receive — mirrors serializeTestWalletEvent's bigint-safety discipline. */
export function serializeTestBillingEvent(event: TestBillingEvent): string {
  return JSON.stringify({ ...event, amountMinor: event.amountMinor?.toString() });
}

export type TestBillingProviderOptions = {
  name?: string;
  signature?: string;
  /** Overrides what createCheckout returns — for tests that need a specific externalPaymentId to correlate with a follow-up webhook event. */
  nextCheckoutResult?: (input: CreateCheckoutInput) => CheckoutSession;
};

/**
 * Deterministic, in-memory BillingProvider used only by tests — mirrors
 * src/server/wallet/providers/fake.ts's "clearly test-only, never
 * reachable from application code" discipline. There is no
 * `BILLING_PROVIDER=test` value (see src/lib/env.ts) — the only way to
 * obtain this provider is a test importing this function directly and
 * passing it as an explicit override to the domain functions under test.
 *
 * Its webhook "signature" is a plain shared-secret header compare, not an
 * attempt to imitate YooKassa's real IP-allowlist mechanism (that is
 * exercised directly against src/server/billing/providers/yookassa.ts's
 * own `isIpAllowed`, real CIDR logic, real IP ranges) — this test double's
 * job is exercising the provider-independent domain logic
 * (src/server/billing/checkout.ts, webhook-events.ts) end-to-end through
 * a real HTTP-shaped verify/parse boundary, including a genuine
 * signature-failure path for the "forged webhook" test scenarios.
 */
export function createTestBillingProvider(options: TestBillingProviderOptions = {}): BillingProvider {
  const name = options.name ?? TEST_BILLING_PROVIDER_NAME;
  const expectedSignature = options.signature ?? DEFAULT_TEST_SIGNATURE;
  let checkoutCounter = 0;

  return {
    name,
    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
      if (options.nextCheckoutResult) return options.nextCheckoutResult(input);
      checkoutCounter += 1;
      return {
        externalPaymentId: `test-payment-${checkoutCounter}` as BillingPaymentId,
        checkoutUrl: `https://billing.test.invalid/checkout/${checkoutCounter}`,
      };
    },
    verifyAndParseWebhook(rawBody, context): NormalizedSubscriptionEvent {
      if (!context.signatureHeader || !safeEqual(context.signatureHeader, expectedSignature)) {
        throw new BillingWebhookVerificationError(name);
      }
      let parsed: TestBillingEvent;
      try {
        parsed = JSON.parse(rawBody) as TestBillingEvent;
      } catch {
        throw new BillingWebhookVerificationError(name);
      }
      if (!parsed.eventId || !parsed.status) {
        throw new BillingWebhookVerificationError(name);
      }
      return {
        eventIdentity: { provider: name, eventId: parsed.eventId },
        paymentId: parsed.paymentId as NormalizedSubscriptionEvent["paymentId"],
        customerId: parsed.customerId as NormalizedSubscriptionEvent["customerId"],
        subscriptionId: parsed.subscriptionId as NormalizedSubscriptionEvent["subscriptionId"],
        status: parsed.status,
        planId: parsed.planId,
        ...(parsed.amountMinor !== undefined
          ? { amountMinor: BigInt(parsed.amountMinor), currency: parsed.currency }
          : {}),
      };
    },
  };
}
