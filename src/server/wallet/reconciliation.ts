import { Prisma, type ReconciliationRejectionReason, type WalletTransaction } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { getBusinessToday } from "@/server/ar/dates";
import { recordPaymentInTransaction } from "@/server/ar/payments";
import { prisma } from "@/server/db/client";
import { WalletResourceNotFoundError } from "./errors";

async function rejectTransaction(
  tx: Prisma.TransactionClient,
  transaction: WalletTransaction,
  reason: ReconciliationRejectionReason,
  matchedRequestId?: string,
): Promise<WalletTransaction> {
  const updated = await tx.walletTransaction.update({
    where: { id: transaction.id },
    data: { reconciliationOutcome: "REJECTED", reconciliationRejectionReason: reason, matchedRequestId },
  });
  await recordActivityEvent(tx, {
    organizationId: transaction.organizationId,
    type: "WALLET_RECONCILIATION_REJECTED",
    summary: `Crypto transaction on ${transaction.network} (${transaction.txHash}) was not automatically reconciled: ${reason}`,
    metadata: { walletTransactionId: transaction.id, reason },
  });
  return updated;
}

/**
 * The transactional body of reconcileWalletTransaction, exported so
 * src/server/wallet/transactions.ts's webhook ingestion pipeline can call
 * this from within its own already-open transaction — see
 * src/server/ar/payments.ts#recordPaymentInTransaction for the identical
 * extraction reasoning (Prisma's interactive transactions don't nest).
 *
 * Idempotent and safe to call repeatedly for the same transaction: once
 * `reconciliationOutcome` is set (MATCHED or REJECTED), every subsequent
 * call is a no-op that returns the existing row unchanged — this is what
 * makes "concurrent reconciliation" and "repeated webhook" both safe (see
 * docs/wallet-architecture.md#idempotency). Never reconciles anything but
 * a CONFIRMED, INCOMING transaction — an unconfirmed or outgoing
 * transaction is left with `reconciliationOutcome` null (not yet
 * attempted), never guessed at.
 *
 * See docs/wallet-architecture.md#reconciliation for the exact matching
 * algorithm (FIFO oldest-open-request-per-wallet+network+asset) and the
 * documented, deliberately conservative rules for underpayment/
 * overpayment — this function never invents an exchange rate or an
 * unearned fiat credit; see the UNDERPAID branch below and
 * ReconciliationRejectionReason's schema doc comment.
 */
export async function reconcileWalletTransactionInTransaction(
  tx: Prisma.TransactionClient,
  organizationId: string,
  transactionId: string,
): Promise<WalletTransaction> {
  const transaction = await tx.walletTransaction.findFirst({ where: { id: transactionId, organizationId } });
  if (!transaction) throw new WalletResourceNotFoundError("WalletTransaction");

  if (transaction.reconciliationOutcome) return transaction; // already processed — idempotent no-op

  if (transaction.direction !== "INCOMING") return transaction; // outgoing transfers are never reconciled
  if (transaction.status === "FAILED") return rejectTransaction(tx, transaction, "TRANSACTION_FAILED");
  if (transaction.status !== "CONFIRMED") return transaction; // not yet reconcilable — never guess at an unconfirmed amount

  // Oldest-first (FIFO) so a wallet shared across several sequential
  // invoices always settles them in the order they were requested — see
  // CryptoPaymentRequest's schema doc comment.
  const request = await tx.cryptoPaymentRequest.findFirst({
    where: {
      organizationId,
      walletId: transaction.walletId,
      network: transaction.network,
      asset: transaction.asset,
      status: "OPEN",
    },
    orderBy: { createdAt: "asc" },
  });
  if (!request) {
    return rejectTransaction(tx, transaction, "NO_OPEN_PAYMENT_REQUEST");
  }

  // Deliberately compared in asset-native units only, never converted to
  // fiat — see docs/wallet-architecture.md#underpayment for why. Meeting
  // or exceeding the expected amount is treated identically (any excess
  // is recorded on the transaction for visibility, never auto-converted
  // into extra fiat credit — the same conservative "never claim more than
  // what's genuinely owed" rule applied below via the outstanding-balance
  // cap).
  if (transaction.amountMinor < request.expectedAssetAmountMinor) {
    return rejectTransaction(tx, transaction, "UNDERPAID", request.id);
  }

  const paidAgg = await tx.payment.aggregate({
    where: { invoiceId: request.invoiceId },
    _sum: { amountMinor: true },
  });
  const paidSoFar = paidAgg._sum.amountMinor ?? 0n;
  const invoiceRow = await tx.invoice.findUniqueOrThrow({ where: { id: request.invoiceId } });
  const rawOutstanding = invoiceRow.amountMinor - paidSoFar;
  const outstandingMinor = rawOutstanding > 0n ? rawOutstanding : 0n;

  if (invoiceRow.status === "CANCELLED" || outstandingMinor <= 0n) {
    return rejectTransaction(tx, transaction, "INVOICE_ALREADY_SETTLED");
  }

  // Never apply more than is genuinely owed, even if the request promised
  // more (e.g. the invoice was partially paid another way after this
  // request was created) — same discipline as recordPayment's own
  // OverpaymentError, applied here as a cap rather than an exception since
  // "less than requested but still fully within what's owed" is a normal,
  // expected outcome here, not an error condition.
  const amountToApply = request.requestedAmountMinor < outstandingMinor ? request.requestedAmountMinor : outstandingMinor;

  // Claim the request immediately before the money-moving step — an
  // atomic compare-and-swap (see src/server/communications/send.ts's
  // identical SENDING claim), so two transactions racing for the same
  // OPEN request can never both apply a Payment against it.
  const claim = await tx.cryptoPaymentRequest.updateMany({
    where: { id: request.id, organizationId, status: "OPEN" },
    data: { status: "FULFILLED" },
  });
  if (claim.count !== 1) {
    return rejectTransaction(tx, transaction, "NO_OPEN_PAYMENT_REQUEST", request.id);
  }

  let payment;
  try {
    payment = await recordPaymentInTransaction(tx, organizationId, request.invoiceId, {
      amountMinor: amountToApply,
      paidAt: getBusinessToday(),
      idempotencyKey: transaction.id,
      note: `Crypto payment received on ${transaction.network} (tx ${transaction.txHash})`,
    });
  } catch {
    // Defense-in-depth only — should be unreachable given the fresh
    // outstanding/status read immediately above. Reverts the claim so a
    // request is never left permanently FULFILLED with no Payment behind
    // it; see docs/wallet-architecture.md#known-limitations.
    await tx.cryptoPaymentRequest.updateMany({
      where: { id: request.id, organizationId, status: "FULFILLED" },
      data: { status: "OPEN" },
    });
    return rejectTransaction(tx, transaction, "INVOICE_ALREADY_SETTLED", request.id);
  }

  const updated = await tx.walletTransaction.update({
    where: { id: transaction.id },
    data: { matchedRequestId: request.id, reconciliationOutcome: "MATCHED", reconciledPaymentId: payment.id },
  });
  await recordActivityEvent(tx, {
    organizationId,
    type: "WALLET_PAYMENT_RECONCILED",
    summary: `Crypto payment on ${transaction.network} reconciled to invoice ${request.invoiceId}`,
    invoiceId: request.invoiceId,
    metadata: { walletTransactionId: transaction.id, requestId: request.id, paymentId: payment.id },
  });
  return updated;
}

export async function reconcileWalletTransaction(organizationId: string, transactionId: string): Promise<WalletTransaction> {
  return prisma.$transaction((tx) => reconcileWalletTransactionInTransaction(tx, organizationId, transactionId));
}
