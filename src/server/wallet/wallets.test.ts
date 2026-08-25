import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { DuplicateWalletAddressError, InvalidWalletTransitionError, WalletResourceNotFoundError } from "./errors";
import { createTestWalletProvider } from "./providers/fake";
import { connectWallet, disconnectWallet, getWallet, listWallets, verifyWalletOwnership } from "./wallets";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const testProvider = createTestWalletProvider();

describe("connectWallet", () => {
  it("creates a wallet as PENDING_VERIFICATION, never ACTIVE on connect alone", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await connectWallet(organization.id, { network: "ETHEREUM", address: "0xabc" }, testProvider);
    expect(wallet.status).toBe("PENDING_VERIFICATION");
    expect(wallet.connectedAt).toBeNull();
  });

  it("never stores anything resembling a private key or seed phrase", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await connectWallet(organization.id, { network: "ETHEREUM", address: "0xabc" }, testProvider);
    const keys = Object.keys(wallet);
    expect(keys).not.toContain("privateKey");
    expect(keys).not.toContain("seedPhrase");
    expect(keys).not.toContain("mnemonic");
  });

  it("rejects a second wallet with the same (network, address) — a real address is watched once, globally", async () => {
    const { organization: orgA } = await createTestOrganization("A");
    const { organization: orgB } = await createTestOrganization("B");
    await connectWallet(orgA.id, { network: "ETHEREUM", address: "0xdupe" }, testProvider);
    await expect(
      connectWallet(orgB.id, { network: "ETHEREUM", address: "0xdupe" }, testProvider),
    ).rejects.toBeInstanceOf(DuplicateWalletAddressError);
  });
});

describe("verifyWalletOwnership", () => {
  it("moves a wallet PENDING_VERIFICATION -> ACTIVE and records WALLET_CONNECTED when the provider confirms ownership", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await connectWallet(organization.id, { network: "ETHEREUM", address: "0xabc" }, testProvider);

    const result = await verifyWalletOwnership(organization.id, wallet.id, { signature: "sig" }, testProvider);

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.wallet.status).toBe("ACTIVE");
      expect(result.wallet.connectedAt).not.toBeNull();
    }
    const events = await prisma.activityEvent.findMany({ where: { organizationId: organization.id } });
    expect(events.some((e) => e.type === "WALLET_CONNECTED")).toBe(true);
  });

  it("leaves the wallet PENDING_VERIFICATION when the provider reports ownership as unverified — a recoverable outcome, not an error", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await connectWallet(organization.id, { network: "ETHEREUM", address: "0xabc" }, testProvider);
    const failingProvider = createTestWalletProvider({ ownershipVerified: false, ownershipReason: "signature mismatch" });

    const result = await verifyWalletOwnership(organization.id, wallet.id, { signature: "bad" }, failingProvider);

    expect(result.verified).toBe(false);
    const current = await getWallet(organization.id, wallet.id);
    expect(current.status).toBe("PENDING_VERIFICATION");
  });

  it("throws for an already-ACTIVE wallet — verification is not re-runnable", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await connectWallet(organization.id, { network: "ETHEREUM", address: "0xabc" }, testProvider);
    await verifyWalletOwnership(organization.id, wallet.id, {}, testProvider);

    await expect(verifyWalletOwnership(organization.id, wallet.id, {}, testProvider)).rejects.toBeInstanceOf(
      InvalidWalletTransitionError,
    );
  });

  it("tenant isolation: throws for a wallet id belonging to another organization", async () => {
    const { organization: orgA } = await createTestOrganization("A");
    const { organization: orgB } = await createTestOrganization("B");
    const wallet = await connectWallet(orgA.id, { network: "ETHEREUM", address: "0xabc" }, testProvider);

    await expect(verifyWalletOwnership(orgB.id, wallet.id, {}, testProvider)).rejects.toBeInstanceOf(
      WalletResourceNotFoundError,
    );
  });
});

describe("disconnectWallet", () => {
  it("moves ACTIVE -> DISCONNECTED and records an activity event", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await connectWallet(organization.id, { network: "ETHEREUM", address: "0xabc" }, testProvider);
    await verifyWalletOwnership(organization.id, wallet.id, {}, testProvider);

    const disconnected = await disconnectWallet(organization.id, wallet.id);
    expect(disconnected.status).toBe("DISCONNECTED");
    const events = await prisma.activityEvent.findMany({ where: { organizationId: organization.id } });
    expect(events.some((e) => e.type === "WALLET_DISCONNECTED")).toBe(true);
  });

  it("is terminal — disconnecting an already-disconnected wallet throws", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await connectWallet(organization.id, { network: "ETHEREUM", address: "0xabc" }, testProvider);
    await disconnectWallet(organization.id, wallet.id);

    await expect(disconnectWallet(organization.id, wallet.id)).rejects.toBeInstanceOf(InvalidWalletTransitionError);
  });

  it("tenant isolation: throws for a wallet id belonging to another organization", async () => {
    const { organization: orgA } = await createTestOrganization("A");
    const { organization: orgB } = await createTestOrganization("B");
    const wallet = await connectWallet(orgA.id, { network: "ETHEREUM", address: "0xabc" }, testProvider);

    await expect(disconnectWallet(orgB.id, wallet.id)).rejects.toBeInstanceOf(WalletResourceNotFoundError);
  });
});

describe("listWallets", () => {
  it("never includes another organization's wallets", async () => {
    const { organization: orgA } = await createTestOrganization("A");
    const { organization: orgB } = await createTestOrganization("B");
    await connectWallet(orgA.id, { network: "ETHEREUM", address: "0xa" }, testProvider);
    await connectWallet(orgB.id, { network: "ETHEREUM", address: "0xb" }, testProvider);

    const listA = await listWallets(orgA.id);
    expect(listA).toHaveLength(1);
    expect(listA[0]!.address).toBe("0xa");
  });

  it("filters by status when asked", async () => {
    const { organization } = await createTestOrganization();
    const w1 = await connectWallet(organization.id, { network: "ETHEREUM", address: "0x1" }, testProvider);
    await connectWallet(organization.id, { network: "ETHEREUM", address: "0x2" }, testProvider);
    await verifyWalletOwnership(organization.id, w1.id, {}, testProvider);

    const active = await listWallets(organization.id, { status: "ACTIVE" });
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(w1.id);
  });
});
