import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { applySubscriptionWebhookEvent } from "@/server/billing/webhook-events";
import { BillingWebhookVerificationError } from "@/server/billing/errors";
import { resolveBillingProvider } from "@/server/billing/service";

/**
 * PAYNORA's own subscription-billing webhook endpoint — see
 * src/server/billing/webhook-events.ts for the provider-independent
 * ingestion pipeline this turns into an actual HTTP route (same relation
 * as src/app/api/webhooks/wallet/[orgSlug]/route.ts for Wallet).
 *
 * Deliberately a single global route, not per-organization like Wallet's:
 * Wallet is a per-org resource (each org can have its own wallet/provider
 * connection), but billing here is the reverse — one PAYNORA merchant
 * account, many organizations as its customers — so a real vendor
 * delivers every event to one URL and the organization is resolved from
 * the verified event's customer/subscription id, inside
 * applySubscriptionWebhookEvent, never from the URL.
 *
 * Currently always returns 503: `resolveBillingProvider()` throws
 * `BillingProviderNotImplementedError` for both recognized vendor names
 * (stripe/yookassa) until a real adapter is registered — see that
 * function's doc comment and docs/provider-strategy.md#billingprovider.
 * This route's shape (response codes, event application) is real and
 * tested now so that landing a real adapter is the only thing left to do
 * — nothing here should need to change.
 *
 * The `x-billing-signature` header name below is a placeholder: Stripe
 * uses `Stripe-Signature`, YooKassa verifies by source IP allowlist +
 * notification shape rather than a signature header at all (see
 * src/server/billing/types.ts's `verifyAndParseWebhook` doc comment) —
 * the real header (or IP-based check) is finalized once a real adapter
 * exists, since it's vendor-specific and inert until then regardless.
 */
export async function POST(request: Request): Promise<Response> {
  if (!env.BILLING_PROVIDER || env.BILLING_PROVIDER === "none") {
    return NextResponse.json({ error: "Billing is not enabled for this deployment" }, { status: 503 });
  }

  let provider;
  try {
    provider = resolveBillingProvider();
  } catch {
    return NextResponse.json({ error: "Billing is not enabled for this deployment" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-billing-signature") ?? "";

  let event;
  try {
    event = provider.verifyAndParseWebhook(rawBody, signatureHeader);
  } catch (error) {
    if (error instanceof BillingWebhookVerificationError) {
      return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
    }
    throw error;
  }

  const result = await applySubscriptionWebhookEvent(event);

  return NextResponse.json({ outcome: result.outcome }, { status: 200 });
}
