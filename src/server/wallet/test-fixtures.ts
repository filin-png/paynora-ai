import type { WalletNetwork } from "./network";
import { createTestWalletProvider } from "./providers/fake";
import { connectWallet, verifyWalletOwnership } from "./wallets";

/** Shared test-only WalletProvider — mirrors src/server/ar/test-fixtures.ts's role for the AR domain. */
export const testWalletProvider = createTestWalletProvider();

/** Creates and verifies a wallet in one call, for tests that only care about having an ACTIVE wallet to work with. */
export async function createActiveTestWallet(
  organizationId: string,
  overrides: { network?: WalletNetwork; address?: string } = {},
) {
  const wallet = await connectWallet(
    organizationId,
    { network: overrides.network ?? "ETHEREUM", address: overrides.address ?? `0x${Math.random().toString(36).slice(2, 10)}` },
    testWalletProvider,
  );
  const result = await verifyWalletOwnership(organizationId, wallet.id, {}, testWalletProvider);
  if (!result.verified) throw new Error("test wallet provider unexpectedly reported unverified ownership");
  return result.wallet;
}
