import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { recordPayment } from "@/server/ar/payments";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createCryptoPaymentRequest } from "./payment-requests";
import { reconcileWalletTransaction } from "./reconciliation";
import { createActiveTestWallet } from "./test-fixtures";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

let invoiceCounter = 0;
async function setupInvoice(organizationId: string, amountMajor = 1000) {
  invoiceCounter += 1;
  const customer = await createCustomer(organizationId, { name: "Acme Co" });
  return createInvoice(organizationId, {
    customerId: customer.id,
    number: `INV-${invoiceCounter}`,
    currency: "USD",
    amountMinor: majorToMinor(amountMajor),
    issueDate: "2026-01-01",
    dueDate: "2026-01-31",
  });
}

let txCounter = 0;
async function createConfirmedIncomingTransaction(
  organizationId: string,
  walletId: string,
  overrides: { network?: string; asset?: string; amountMinor?: bigint; status?: "CONFIRMED" | "FAILED" } = {},
) {
  txCounter += 1;
  return prisma.walletTransaction.create({
    data: {
      organizationId,
      walletId,
      network: overrides.network ?? "ETHEREUM",
      txHash: `0xtx-${txCounter}`,
      direction: "INCOMING",
      asset: overrides.asset ?? "USDT",
      assetDecimals: 6,
      amountMinor: overrides.amountMinor ?? 1_000_000_000n,
      toAddress: "0xmerchant",
      status: overrides.status ?? "CONFIRMED",
      confirmations: 3,
      requiredConfirmations: 3,
      providerName: "test",
    },
  });
}

async function setupRequest(
  organizationId: string,
  userId: string,
  invoiceId: string,
  walletId: string,
  overrides: { expectedAssetAmountMinor?: bigint; requestedAmountMinor?: bigint } = {},
) {
  return createCryptoPaymentRequest(organizationId, userId, {
    invoiceId,
    walletId,
    network: "ETHEREUM",
    asset: "USDT",
    assetDecimals: 6,
    expectedAssetAmountMinor: overrides.expectedAssetAmountMinor ?? 1_000_000_000n,
    requestedAmountMinor: overrides.requestedAmountMinor ?? majorToMinor(1000),
  });
}

describe("reconcileWalletTransaction — exact / under / over payment", () => {
  it("matches an exact payment: creates a Payment and fully pays the invoice", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id, 1000);
    const wallet = await createActiveTestWallet(organization.id);
    const request = await setupRequest(organization.id, user.id, invoice.id, wallet.id);
    const tx = await createConfirmedIncomingTransaction(organization.id, wallet.id, { amountMinor: 1_000_000_000n });

    const result = await reconcileWalletTransaction(organization.id, tx.id);

    expect(result.reconciliationOutcome).toBe("MATCHED");
    expect(result.reconciledPaymentId).not.toBeNull();
    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amountMinor).toBe(majorToMinor(1000));
    const updatedRequest = await prisma.cryptoPaymentRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(updatedRequest.status).toBe("FULFILLED");
  });

  it("rejects an underpayment (received less than expected asset amount) and leaves the request OPEN — never invents a partial fiat conversion", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id, 1000);
    const wallet = await createActiveTestWallet(organization.id);
    const request = await setupRequest(organization.id, user.id, invoice.id, wallet.id, {
      expectedAssetAmountMinor: 1_000_000_000n,
    });
    const tx = await createConfirmedIncomingTransaction(organization.id, wallet.id, { amountMinor: 500_000_000n });

    const result = await reconcileWalletTransaction(organization.id, tx.id);

    expect(result.reconciliationOutcome).toBe("REJECTED");
    expect(result.reconciliationRejectionReason).toBe("UNDERPAID");
    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments).toHaveLength(0);
    const updatedRequest = await prisma.cryptoPaymentRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(updatedRequest.status).toBe("OPEN");
  });

  it("matches an overpayment (received more than expected) but never applies more fiat than the invoice's outstanding balance", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id, 1000);
    const wallet = await createActiveTestWallet(organization.id);
    await setupRequest(organization.id, user.id, invoice.id, wallet.id, {
      expectedAssetAmountMinor: 1_000_000_000n,
      requestedAmountMinor: majorToMinor(1000),
    });
    const tx = await createConfirmedIncomingTransaction(organization.id, wallet.id, { amountMinor: 1_500_000_000n });

    const result = await reconcileWalletTransaction(organization.id, tx.id);

    expect(result.reconciliationOutcome).toBe("MATCHED");
    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amountMinor).toBe(majorToMinor(1000)); // never more than requested/owed
  });
});

describe("reconcileWalletTransaction — partial payments across multiple requests", () => {
  it("supports two sequential crypto payments that together fully pay one invoice", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id, 1000);
    const wallet = await createActiveTestWallet(organization.id);

    const requestA = await setupRequest(organization.id, user.id, invoice.id, wallet.id, {
      expectedAssetAmountMinor: 400_000_000n,
      requestedAmountMinor: majorToMinor(400),
    });
    const txA = await createConfirmedIncomingTransaction(organization.id, wallet.id, { amountMinor: 400_000_000n });
    const resultA = await reconcileWalletTransaction(organization.id, txA.id);
    expect(resultA.reconciliationOutcome).toBe("MATCHED");

    const requestB = await setupRequest(organization.id, user.id, invoice.id, wallet.id, {
      expectedAssetAmountMinor: 600_000_000n,
      requestedAmountMinor: majorToMinor(600),
    });
    const txB = await createConfirmedIncomingTransaction(organization.id, wallet.id, { amountMinor: 600_000_000n });
    const resultB = await reconcileWalletTransaction(organization.id, txB.id);
    expect(resultB.reconciliationOutcome).toBe("MATCHED");

    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments).toHaveLength(2);
    const total = payments.reduce((sum, p) => sum + p.amountMinor, 0n);
    expect(total).toBe(majorToMinor(1000));
    expect([requestA.id, requestB.id]).toContain(resultA.matchedRequestId);
  });

  it("matches OPEN requests oldest-first (FIFO) for the same wallet/network/asset", async () => {
    const { organization, user } = await createTestOrganization();
    const invoiceA = await setupInvoice(organization.id, 100);
    const invoiceB = await setupInvoice(organization.id, 100);
    const wallet = await createActiveTestWallet(organization.id);

    const older = await setupRequest(organization.id, user.id, invoiceA.id, wallet.id, {
      expectedAssetAmountMinor: 100_000_000n,
      requestedAmountMinor: majorToMinor(100),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await setupRequest(organization.id, user.id, invoiceB.id, wallet.id, {
      expectedAssetAmountMinor: 100_000_000n,
      requestedAmountMinor: majorToMinor(100),
    });

    const tx = await createConfirmedIncomingTransaction(organization.id, wallet.id, { amountMinor: 100_000_000n });
    const result = await reconcileWalletTransaction(organization.id, tx.id);

    expect(result.matchedRequestId).toBe(older.id);
  });
});

describe("reconcileWalletTransaction — rejection paths", () => {
  it("rejects with NO_OPEN_PAYMENT_REQUEST when no request matches this wallet/network/asset", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await createActiveTestWallet(organization.id);
    const tx = await createConfirmedIncomingTransaction(organization.id, wallet.id);

    const result = await reconcileWalletTransaction(organization.id, tx.id);
    expect(result.reconciliationOutcome).toBe("REJECTED");
    expect(result.reconciliationRejectionReason).toBe("NO_OPEN_PAYMENT_REQUEST");
  });

  it("rejects a FAILED transaction with TRANSACTION_FAILED, even with a matching open request", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id);
    const wallet = await createActiveTestWallet(organization.id);
    await setupRequest(organization.id, user.id, invoice.id, wallet.id);
    const tx = await createConfirmedIncomingTransaction(organization.id, wallet.id, { status: "FAILED" });

    const result = await reconcileWalletTransaction(organization.id, tx.id);
    expect(result.reconciliationOutcome).toBe("REJECTED");
    expect(result.reconciliationRejectionReason).toBe("TRANSACTION_FAILED");
  });

  it("rejects with INVOICE_ALREADY_SETTLED when the invoice was already fully paid another way", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id, 1000);
    const wallet = await createActiveTestWallet(organization.id);
    await setupRequest(organization.id, user.id, invoice.id, wallet.id, { requestedAmountMinor: majorToMinor(1000) });
    // Paid off entirely via a normal bank/manual payment before the crypto transaction confirms.
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(1000), paidAt: "2026-01-15" });
    const tx = await createConfirmedIncomingTransaction(organization.id, wallet.id, { amountMinor: 1_000_000_000n });

    const result = await reconcileWalletTransaction(organization.id, tx.id);
    expect(result.reconciliationOutcome).toBe("REJECTED");
    expect(result.reconciliationRejectionReason).toBe("INVOICE_ALREADY_SETTLED");
    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments).toHaveLength(1); // only the manual one — never a second, duplicate settlement
  });

  it("leaves a not-yet-confirmed transaction unreconciled (reconciliationOutcome stays null)", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id);
    const wallet = await createActiveTestWallet(organization.id);
    await setupRequest(organization.id, user.id, invoice.id, wallet.id);
    const tx = await prisma.walletTransaction.create({
      data: {
        organizationId: organization.id,
        walletId: wallet.id,
        network: "ETHEREUM",
        txHash: "0xpending",
        direction: "INCOMING",
        asset: "USDT",
        assetDecimals: 6,
        amountMinor: 1_000_000_000n,
        toAddress: "0xmerchant",
        status: "CONFIRMING",
        confirmations: 1,
        requiredConfirmations: 3,
        providerName: "test",
      },
    });

    const result = await reconcileWalletTransaction(organization.id, tx.id);
    expect(result.reconciliationOutcome).toBeNull();
  });
});

describe("reconcileWalletTransaction — idempotency and concurrency", () => {
  it("is idempotent: calling it twice on an already-MATCHED transaction never creates a second Payment", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id, 1000);
    const wallet = await createActiveTestWallet(organization.id);
    await setupRequest(organization.id, user.id, invoice.id, wallet.id);
    const tx = await createConfirmedIncomingTransaction(organization.id, wallet.id, { amountMinor: 1_000_000_000n });

    const first = await reconcileWalletTransaction(organization.id, tx.id);
    const second = await reconcileWalletTransaction(organization.id, tx.id);

    expect(second.reconciledPaymentId).toBe(first.reconciledPaymentId);
    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments).toHaveLength(1);
  });

  it("concurrent reconciliation of two transactions racing for the same OPEN request: exactly one wins, the invoice is never overpaid", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id, 1000);
    const wallet = await createActiveTestWallet(organization.id);
    await setupRequest(organization.id, user.id, invoice.id, wallet.id, { requestedAmountMinor: majorToMinor(1000) });
    const txA = await createConfirmedIncomingTransaction(organization.id, wallet.id, { amountMinor: 1_000_000_000n });
    const txB = await createConfirmedIncomingTransaction(organization.id, wallet.id, { amountMinor: 1_000_000_000n });

    const [resultA, resultB] = await Promise.all([
      reconcileWalletTransaction(organization.id, txA.id),
      reconcileWalletTransaction(organization.id, txB.id),
    ]);

    const outcomes = [resultA.reconciliationOutcome, resultB.reconciliationOutcome].sort();
    expect(outcomes).toEqual(["MATCHED", "REJECTED"]);
    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments).toHaveLength(1);
  });

  it("tenant isolation: throws for a transaction id belonging to another organization", async () => {
    const { organization: orgA } = await createTestOrganization("A");
    const { organization: orgB } = await createTestOrganization("B");
    const walletA = await createActiveTestWallet(orgA.id);
    const tx = await createConfirmedIncomingTransaction(orgA.id, walletA.id);

    await expect(reconcileWalletTransaction(orgB.id, tx.id)).rejects.toThrow();
  });
});
