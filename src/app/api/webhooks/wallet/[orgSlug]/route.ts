import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { prisma } from "@/server/db/client";
import { resolveWalletProvider } from "@/server/wallet/service";
import { ingestWalletWebhookEvent } from "@/server/wallet/transactions";

/**
 * The real per-organization wallet webhook endpoint — turns Phase 13's
 * provider-independent ingestion pipeline
 * (src/server/wallet/transactions.ts#ingestWalletWebhookEvent) into an
 * actual HTTP route. See docs/production-integrations.md#webhooks.
 *
 * Deliberately unauthenticated by session (this is an external provider
 * calling PAYNORA, not a logged-in user) — the webhook's own signature is
 * the real authentication, verified inside `ingestWalletWebhookEvent` via
 * the resolved WalletProvider. The organization is resolved from the URL
 * slug alone, before the body is even read, so a request for an unknown
 * organization never reaches signature verification or the wallet domain
 * at all.
 *
 * Response codes matter here — see the phase brief's webhook-retry
 * guidance: 401 for a failed signature (the provider should not blindly
 * retry an unauthenticated request forever, though some do regardless);
 * 200 for every other outcome (unknown wallet, stale replay, or a
 * successful ingest) — the delivery was received and handled, whether or
 * not it resulted in a state change, so the provider should not retry it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ orgSlug: string }> }): Promise<Response> {
  const { orgSlug } = await params;
  const organization = await prisma.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } });
  if (!organization) {
    return NextResponse.json({ error: "Unknown organization" }, { status: 404 });
  }

  if (!env.WALLET_PROVIDER || env.WALLET_PROVIDER === "none") {
    return NextResponse.json({ error: "Wallet integration is not enabled for this deployment" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-alchemy-signature") ?? "";

  let provider;
  try {
    provider = resolveWalletProvider();
  } catch {
    return NextResponse.json({ error: "Wallet integration is not enabled for this deployment" }, { status: 503 });
  }

  const result = await ingestWalletWebhookEvent(organization.id, rawBody, signatureHeader, provider);

  if (result.outcome === "rejected" && result.reason === "signature_verification_failed") {
    return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
  }

  return NextResponse.json({ outcome: result.outcome }, { status: 200 });
}
