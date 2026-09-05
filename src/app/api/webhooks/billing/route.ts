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
 * `resolveBillingProvider()` throws `BillingDisabledError` (503) when
 * BILLING_PROVIDER=none, or `BillingProviderNotConfiguredError` (also 503)
 * when a real adapter (yookassa, Phase 20) is selected but missing
 * credentials in this deployment.
 *
 * The `x-billing-signature` header is only meaningful for a
 * signature-verifying provider (Stripe would use `Stripe-Signature`
 * instead — not yet implemented). YooKassa (the real Phase 20 adapter)
 * verifies authenticity by source IP allowlist rather than a signature
 * header — see src/server/billing/providers/yookassa.ts. Both are passed
 * through as a `WebhookVerificationContext` and it's each provider's own
 * job to check whichever one it actually uses.
 *
 * `sourceIp` is read from `x-real-ip` first, falling back to the first
 * hop of `x-forwarded-for` — trusted here because this route is only
 * reachable through the deployment's own reverse proxy, which sets these
 * headers itself; it is never client-settable directly in production.
 */
export function extractSourceIp(request: Request): string | undefined {
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim();
  return undefined;
}

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
  const signatureHeader = request.headers.get("x-billing-signature") ?? undefined;
  const sourceIp = extractSourceIp(request);

  let event;
  try {
    event = provider.verifyAndParseWebhook(rawBody, { signatureHeader, sourceIp });
  } catch (error) {
    if (error instanceof BillingWebhookVerificationError) {
      return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
    }
    throw error;
  }

  const result = await applySubscriptionWebhookEvent(event);

  return NextResponse.json({ outcome: result.outcome }, { status: 200 });
}
