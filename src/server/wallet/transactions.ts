import { Prisma, type WalletTransaction } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";
import { WalletResourceNotFoundError, WalletWebhookVerificationError } from "./errors";
import type { RawWalletEvent, WalletProvider } from "./provider-types";
import { reconcileWalletTransactionInTransaction } from "./reconciliation";
import { isValidWalletTransactionTransition } from "./transaction-state-machine";

export type IngestWalletWebhookResult =
  | { outcome: "rejected"; reason: "signature_verification_failed" | "unknown_wallet" }
  | { outcome: "ignored_stale_replay"; transaction: WalletTransaction }
  | { outcome: "ingested"; transaction: WalletTransaction; isNewTransaction: boolean };

/**
 * The provider-independent webhook ingestion pipeline from the phase
 * brief (section 12): verify -> normalize -> resolve this org's wallet ->
 * idempotency -> transaction state update -> payment reconciliation ->
 * invoice update -> activity/audit event, all in one call, one commit.
 *
 * `organizationId` is supplied by the caller — this phase's intended
 * deployment shape is one webhook endpoint per organization (e.g.
 * `/api/webhooks/wallet/[orgSlug]`, not built in this phase — see
 * docs/wallet-architecture.md#production-integration-point), so the org is
 * already known from the route before any payload is even parsed. This is
 * what lets a *known* org's rejected deliveries (bad signature, unknown
 * destination) be recorded as a real, tenant-scoped
 * WALLET_WEBHOOK_REJECTED activity event rather than only ever logged to
 * the server console.
 *
 * Idempotent by `WalletTransaction.@@unique([network, txHash])`: a
 * repeated delivery for the same on-chain transaction always resolves to
 * the same row (create, catch P2002, then update-or-ignore) — the same
 * precedent as BusinessEvent/Payment. A delivery reporting a status the
 * transaction's current status can't legally transition to (see
 * src/server/wallet/transaction-state-machine.ts) is treated as a stale,
 * out-of-order replay and safely ignored rather than applied.
 */
export async function ingestWalletWebhookEvent(
  organizationId: string,
  rawBody: string,
  signatureHeader: string,
  provider: WalletProvider,
): Promise<IngestWalletWebhookResult> {
  let event: RawWalletEvent;
  try {
    event = provider.verifyAndParseWebhookEvent(rawBody, signatureHeader);
  } catch (error) {
    if (error instanceof WalletWebhookVerificationError) {
      await recordActivityEvent(prisma, {
        organizationId,
        type: "WALLET_WEBHOOK_REJECTED",
        summary: `Webhook from provider "${provider.name}" rejected: signature verification failed`,
        metadata: { providerName: provider.name, reason: "signature_verification_failed" },
      });
      return { outcome: "rejected", reason: "signature_verification_failed" };
    }
    throw error;
  }

  const wallet = await prisma.wallet.findFirst({
    where: { organizationId, network: event.network, address: event.toAddress },
  });
  if (!wallet) {
    await recordActivityEvent(prisma, {
      organizationId,
      type: "WALLET_WEBHOOK_REJECTED",
      summary: `Webhook from provider "${provider.name}" rejected: destination address is not a wallet connected to this organization`,
      metadata: { providerName: provider.name, reason: "unknown_wallet", network: event.network },
    });
    return { outcome: "rejected", reason: "unknown_wallet" };
  }

  return prisma.$transaction(async (tx) => {
    let transaction: WalletTransaction;
    let isNewTransaction = false;
    let justConfirmed = false;

    // Checked explicitly, before ever attempting the insert, rather than
    // relying on a catch-P2002-then-continue pattern: Postgres aborts a
    // transaction the instant any statement inside it errors, so a second
    // query issued after catching that error would itself fail with
    // "current transaction is aborted" — there is no SAVEPOINT here to
    // recover into. A genuinely concurrent double-insert for a brand-new
    // txHash (two deliveries racing before either commits) still can't
    // create a duplicate row — the loser's `create` throws, its whole
    // transaction rolls back cleanly, and it propagates as an error the
    // caller can retry (a webhook's normal retry-on-non-2xx behavior then
    // finds this same row via the `existing` branch below).
    const existing = await tx.walletTransaction.findFirst({
      where: { network: event.network, txHash: event.txHash },
    });

    if (!existing) {
      transaction = await tx.walletTransaction.create({
        data: {
          organizationId,
          walletId: wallet.id,
          network: event.network,
          txHash: event.txHash,
          direction: event.direction,
          asset: event.asset,
          assetDecimals: event.assetDecimals,
          amountMinor: event.amountMinor,
          fromAddress: event.fromAddress,
          toAddress: event.toAddress,
          status: event.status,
          confirmations: event.confirmations,
          requiredConfirmations: event.requiredConfirmations,
          confirmedAt: event.status === "CONFIRMED" ? event.observedAt : undefined,
          failureReason: event.status === "FAILED" ? "Reported as failed by the provider" : undefined,
          providerName: provider.name,
          providerEventId: event.providerEventId,
          metadata: event.metadata as Prisma.InputJsonValue | undefined,
        },
      });
      isNewTransaction = true;
      justConfirmed = event.status === "CONFIRMED";
      await recordActivityEvent(tx, {
        organizationId,
        type: "WALLET_TRANSACTION_DETECTED",
        summary: `${event.direction === "INCOMING" ? "Incoming" : "Outgoing"} ${event.asset} transaction detected on ${event.network}`,
        metadata: { walletId: wallet.id, network: event.network, txHash: event.txHash, asset: event.asset },
      });
    } else {
      if (existing.organizationId !== organizationId) {
        // Structurally shouldn't happen — Wallet.@@unique([network,
        // address]) already ties one address to one organization — but
        // tenant isolation is never assumed true on a downstream branch
        // without an explicit check.
        return { outcome: "rejected" as const, reason: "unknown_wallet" as const };
      }
      if (!isValidWalletTransactionTransition(existing.status, event.status)) {
        return { outcome: "ignored_stale_replay" as const, transaction: existing };
      }
      justConfirmed = event.status === "CONFIRMED" && existing.status !== "CONFIRMED";
      transaction = await tx.walletTransaction.update({
        where: { id: existing.id },
        data: {
          status: event.status,
          confirmations: event.confirmations,
          requiredConfirmations: event.requiredConfirmations,
          confirmedAt: event.status === "CONFIRMED" ? event.observedAt : existing.confirmedAt,
          failureReason: event.status === "FAILED" ? "Reported as failed by the provider" : existing.failureReason,
        },
      });
    }

    if (justConfirmed) {
      await recordActivityEvent(tx, {
        organizationId,
        type: "WALLET_TRANSACTION_CONFIRMED",
        summary: `${transaction.asset} transaction confirmed on ${transaction.network}`,
        metadata: { walletId: wallet.id, network: transaction.network, txHash: transaction.txHash },
      });
    }

    if (transaction.status === "CONFIRMED" && transaction.direction === "INCOMING" && !transaction.reconciliationOutcome) {
      transaction = await reconcileWalletTransactionInTransaction(tx, organizationId, transaction.id);
    }

    return { outcome: "ingested" as const, transaction, isNewTransaction };
  });
}

export async function getWalletTransaction(organizationId: string, transactionId: string) {
  const transaction = await prisma.walletTransaction.findFirst({ where: { id: transactionId, organizationId } });
  if (!transaction) throw new WalletResourceNotFoundError("WalletTransaction");
  return transaction;
}

export async function listWalletTransactions(organizationId: string, options: { walletId?: string } = {}) {
  return prisma.walletTransaction.findMany({
    where: { organizationId, ...(options.walletId ? { walletId: options.walletId } : {}) },
    orderBy: { detectedAt: "desc" },
    take: 200,
  });
}
