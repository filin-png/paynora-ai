import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { ExceedsOutstandingBalanceError, InvalidWalletTransitionError, WalletResourceNotFoundError } from "./errors";
import {
  cancelCryptoPaymentRequest,
  createCryptoPaymentRequest,
  listCryptoPaymentRequestsForInvoice,
} from "./payment-requests";
import { createActiveTestWallet, testWalletProvider } from "./test-fixtures";
import { connectWallet } from "./wallets";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

async function setupInvoice(organizationId: string, amountMajor = 1000) {
  const customer = await createCustomer(organizationId, { name: "Acme Co" });
  return createInvoice(organizationId, {
    customerId: customer.id,
    number: "INV-1",
    currency: "USD",
    amountMinor: majorToMinor(amountMajor),
    issueDate: "2026-01-01",
    dueDate: "2026-01-31",
  });
}

describe("createCryptoPaymentRequest", () => {
  it("creates an OPEN request when the requested amount is within the invoice's outstanding balance", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id);
    const wallet = await createActiveTestWallet(organization.id);

    const request = await createCryptoPaymentRequest(organization.id, user.id, {
      invoiceId: invoice.id,
      walletId: wallet.id,
      network: "ETHEREUM",
      asset: "USDT",
      assetDecimals: 6,
      expectedAssetAmountMinor: 1_000_000_000n,
      requestedAmountMinor: majorToMinor(1000),
    });

    expect(request.status).toBe("OPEN");
  });

  it("rejects a request for more than the invoice's current outstanding balance", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id, 500);
    const wallet = await createActiveTestWallet(organization.id);

    await expect(
      createCryptoPaymentRequest(organization.id, user.id, {
        invoiceId: invoice.id,
        walletId: wallet.id,
        network: "ETHEREUM",
        asset: "USDT",
        assetDecimals: 6,
        expectedAssetAmountMinor: 1_000_000_000n,
        requestedAmountMinor: majorToMinor(600),
      }),
    ).rejects.toBeInstanceOf(ExceedsOutstandingBalanceError);
  });

  it("rejects a wallet that is not yet ACTIVE (still PENDING_VERIFICATION)", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id);
    const pendingWallet = await connectWallet(
      organization.id,
      { network: "ETHEREUM", address: "0xpending" },
      testWalletProvider,
    );

    await expect(
      createCryptoPaymentRequest(organization.id, user.id, {
        invoiceId: invoice.id,
        walletId: pendingWallet.id,
        network: "ETHEREUM",
        asset: "USDT",
        assetDecimals: 6,
        expectedAssetAmountMinor: 1_000_000n,
        requestedAmountMinor: majorToMinor(10),
      }),
    ).rejects.toBeInstanceOf(InvalidWalletTransitionError);
  });

  it("rejects a network that does not match the wallet's own network", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id);
    const wallet = await createActiveTestWallet(organization.id, { network: "ETHEREUM" });

    await expect(
      createCryptoPaymentRequest(organization.id, user.id, {
        invoiceId: invoice.id,
        walletId: wallet.id,
        network: "BITCOIN",
        asset: "BTC",
        assetDecimals: 8,
        expectedAssetAmountMinor: 100_000n,
        requestedAmountMinor: majorToMinor(10),
      }),
    ).rejects.toBeInstanceOf(WalletResourceNotFoundError);
  });

  it("tenant isolation: throws for an invoice id belonging to another organization", async () => {
    const { organization: orgA } = await createTestOrganization("A");
    const { organization: orgB, user: userB } = await createTestOrganization("B");
    const invoiceA = await setupInvoice(orgA.id);
    const walletB = await createActiveTestWallet(orgB.id);

    await expect(
      createCryptoPaymentRequest(orgB.id, userB.id, {
        invoiceId: invoiceA.id,
        walletId: walletB.id,
        network: "ETHEREUM",
        asset: "USDT",
        assetDecimals: 6,
        expectedAssetAmountMinor: 1_000_000n,
        requestedAmountMinor: majorToMinor(10),
      }),
    ).rejects.toThrow();
  });
});

describe("cancelCryptoPaymentRequest", () => {
  it("moves OPEN -> CANCELLED", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id);
    const wallet = await createActiveTestWallet(organization.id);
    const request = await createCryptoPaymentRequest(organization.id, user.id, {
      invoiceId: invoice.id,
      walletId: wallet.id,
      network: "ETHEREUM",
      asset: "USDT",
      assetDecimals: 6,
      expectedAssetAmountMinor: 1_000_000n,
      requestedAmountMinor: majorToMinor(10),
    });

    const cancelled = await cancelCryptoPaymentRequest(organization.id, request.id);
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("cannot cancel a request that is not OPEN", async () => {
    const { organization, user } = await createTestOrganization();
    const invoice = await setupInvoice(organization.id);
    const wallet = await createActiveTestWallet(organization.id);
    const request = await createCryptoPaymentRequest(organization.id, user.id, {
      invoiceId: invoice.id,
      walletId: wallet.id,
      network: "ETHEREUM",
      asset: "USDT",
      assetDecimals: 6,
      expectedAssetAmountMinor: 1_000_000n,
      requestedAmountMinor: majorToMinor(10),
    });
    await cancelCryptoPaymentRequest(organization.id, request.id);

    await expect(cancelCryptoPaymentRequest(organization.id, request.id)).rejects.toBeInstanceOf(
      InvalidWalletTransitionError,
    );
  });
});

describe("listCryptoPaymentRequestsForInvoice", () => {
  it("never includes another organization's requests", async () => {
    const { organization: orgA, user: userA } = await createTestOrganization("A");
    const { organization: orgB } = await createTestOrganization("B");
    const invoiceA = await setupInvoice(orgA.id);
    const walletA = await createActiveTestWallet(orgA.id);
    await createCryptoPaymentRequest(orgA.id, userA.id, {
      invoiceId: invoiceA.id,
      walletId: walletA.id,
      network: "ETHEREUM",
      asset: "USDT",
      assetDecimals: 6,
      expectedAssetAmountMinor: 1_000_000n,
      requestedAmountMinor: majorToMinor(10),
    });

    expect(await listCryptoPaymentRequestsForInvoice(orgB.id, invoiceA.id)).toEqual([]);
  });
});
