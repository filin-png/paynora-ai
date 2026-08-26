import { z } from "zod";

import { trackEvent } from "@/server/analytics/events";
import { getInvoiceWithFinancials } from "@/server/ar/invoices";
import { amountMinorSchema } from "@/server/ar/money";
import { prisma } from "@/server/db/client";
import { ExceedsOutstandingBalanceError, InvalidWalletTransitionError, WalletResourceNotFoundError } from "./errors";
import { walletAssetSchema, walletNetworkSchema } from "./network";
import { getWallet } from "./wallets";

export const cryptoPaymentRequestInputSchema = z.object({
  invoiceId: z.string().min(1),
  walletId: z.string().min(1),
  network: walletNetworkSchema,
  asset: walletAssetSchema,
  assetDecimals: z.number().int().min(0).max(30),
  expectedAssetAmountMinor: z.bigint().positive("Expected amount must be greater than zero"),
  requestedAmountMinor: amountMinorSchema,
});

export type CryptoPaymentRequestInput = z.input<typeof cryptoPaymentRequestInputSchema>;

/**
 * Registers the expectation reconciliation later matches an incoming
 * on-chain transaction against — see
 * docs/wallet-architecture.md#reconciliation for why this row must exist
 * before a transaction can ever be reconciled at all (a blockchain
 * transaction carries no PAYNORA invoice id).
 *
 * `requestedAmountMinor` (the fiat amount this request settles) is capped
 * at the invoice's *current* outstanding balance at creation time — the
 * same OverpaymentError-avoidance discipline recordPayment already
 * enforces at settlement time, applied here at request-creation time too,
 * so a request can never even be created promising to collect more than
 * is genuinely owed. The exchange rate implied between
 * `requestedAmountMinor` and `expectedAssetAmountMinor` is fixed here by
 * the caller (this phase has no live FX-rate provider) — see
 * docs/wallet-architecture.md#known-limitations.
 */
export async function createCryptoPaymentRequest(
  organizationId: string,
  createdByUserId: string,
  rawInput: CryptoPaymentRequestInput,
) {
  const input = cryptoPaymentRequestInputSchema.parse(rawInput);

  const wallet = await getWallet(organizationId, input.walletId);
  if (wallet.status !== "ACTIVE") {
    throw new InvalidWalletTransitionError(wallet.status, "only an ACTIVE wallet can receive a crypto payment request");
  }
  if (wallet.network !== input.network) {
    throw new WalletResourceNotFoundError("Wallet");
  }

  const { financials } = await getInvoiceWithFinancials(organizationId, input.invoiceId);
  if (input.requestedAmountMinor > financials.outstandingMinor) {
    throw new ExceedsOutstandingBalanceError(financials.outstandingMinor);
  }

  const request = await prisma.cryptoPaymentRequest.create({
    data: {
      organizationId,
      invoiceId: input.invoiceId,
      walletId: wallet.id,
      network: input.network,
      asset: input.asset,
      assetDecimals: input.assetDecimals,
      expectedAssetAmountMinor: input.expectedAssetAmountMinor,
      requestedAmountMinor: input.requestedAmountMinor,
      createdByUserId,
      status: "OPEN",
    },
  });
  trackEvent("crypto_payment_requested", { organizationId, properties: { network: input.network, asset: input.asset } });
  return request;
}

export async function getCryptoPaymentRequest(organizationId: string, requestId: string) {
  const request = await prisma.cryptoPaymentRequest.findFirst({ where: { id: requestId, organizationId } });
  if (!request) throw new WalletResourceNotFoundError("CryptoPaymentRequest");
  return request;
}

export async function listCryptoPaymentRequestsForInvoice(organizationId: string, invoiceId: string) {
  return prisma.cryptoPaymentRequest.findMany({
    where: { organizationId, invoiceId },
    orderBy: { createdAt: "desc" },
  });
}

/** OPEN -> CANCELLED only — a request already FULFILLED or EXPIRED is never retroactively cancellable. */
export async function cancelCryptoPaymentRequest(organizationId: string, requestId: string) {
  const claim = await prisma.cryptoPaymentRequest.updateMany({
    where: { id: requestId, organizationId, status: "OPEN" },
    data: { status: "CANCELLED" },
  });
  if (claim.count !== 1) {
    const current = await prisma.cryptoPaymentRequest.findFirst({ where: { id: requestId, organizationId } });
    if (!current) throw new WalletResourceNotFoundError("CryptoPaymentRequest");
    throw new InvalidWalletTransitionError(current.status, "only an OPEN payment request can be cancelled");
  }
  return prisma.cryptoPaymentRequest.findUniqueOrThrow({ where: { id: requestId } });
}
