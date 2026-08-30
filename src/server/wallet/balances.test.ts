import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { WalletResourceNotFoundError } from "./errors";
import { createTestWalletProvider } from "./providers/fake";
import { connectWallet, verifyWalletOwnership } from "./wallets";
import { getWalletBalances } from "./balances";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const testProvider = createTestWalletProvider();

async function createActiveWallet(organizationId: string) {
  const wallet = await connectWallet(organizationId, { network: "ETHEREUM", address: "0xabc" }, testProvider);
  await verifyWalletOwnership(organizationId, wallet.id, { signature: "sig" }, testProvider);
  return wallet;
}

describe("getWalletBalances", () => {
  it("returns not_connected for a wallet that hasn't completed ownership verification", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await connectWallet(organization.id, { network: "ETHEREUM", address: "0xabc" }, testProvider);

    const result = await getWalletBalances(organization.id, wallet.id, testProvider);

    expect(result).toEqual({ status: "not_connected" });
  });

  it("returns real balances for an ACTIVE wallet", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await createActiveWallet(organization.id);
    const balances = [
      { assetType: "native" as const, asset: "ETH", assetDecimals: 18, amountMinor: 1_000_000_000_000_000_000n, chain: "ETHEREUM" as const },
    ];
    const provider = createTestWalletProvider({ balances });

    const result = await getWalletBalances(organization.id, wallet.id, provider);

    expect(result).toEqual({ status: "ok", balances });
  });

  it("returns an empty balances array (not an error) when the wallet genuinely holds nothing", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await createActiveWallet(organization.id);
    const provider = createTestWalletProvider({ balances: [] });

    const result = await getWalletBalances(organization.id, wallet.id, provider);

    expect(result).toEqual({ status: "ok", balances: [] });
  });

  it("returns status: error (never throws) when the provider call fails", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await createActiveWallet(organization.id);
    const failingProvider = {
      ...testProvider,
      async getBalances(): Promise<never> {
        throw new Error("provider down");
      },
    };

    const result = await getWalletBalances(organization.id, wallet.id, failingProvider);

    expect(result).toEqual({ status: "error" });
  });

  it("tenant isolation: throws for a wallet id belonging to another organization", async () => {
    const { organization: orgA } = await createTestOrganization("A");
    const { organization: orgB } = await createTestOrganization("B");
    const wallet = await createActiveWallet(orgA.id);

    await expect(getWalletBalances(orgB.id, wallet.id, testProvider)).rejects.toThrow(WalletResourceNotFoundError);
  });

  it("throws for a nonexistent wallet id", async () => {
    const { organization } = await createTestOrganization();

    await expect(getWalletBalances(organization.id, "nonexistent-id", testProvider)).rejects.toThrow(
      WalletResourceNotFoundError,
    );
  });
});
