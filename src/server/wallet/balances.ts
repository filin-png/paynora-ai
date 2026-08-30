import { getWallet } from "./wallets";
import type { WalletBalance, WalletProvider } from "./provider-types";
import type { WalletNetwork } from "./network";

export type WalletBalancesResult =
  | { status: "not_connected" }
  | { status: "error" }
  | { status: "ok"; balances: WalletBalance[] };

/**
 * Real balances for one wallet, or an honest reason there are none —
 * never fabricated, never a stale cached value presented as current.
 * `getWallet` is already tenant-scoped (throws for a wallet id belonging
 * to another organization or that doesn't exist), so cross-tenant access
 * is rejected before any provider call is even considered.
 *
 * `provider` is required and explicit — mirrors `connectWallet`/
 * `verifyWalletOwnership` (src/server/wallet/wallets.ts) exactly: the
 * caller resolves `WALLET_PROVIDER` (or decides the feature is disabled
 * and never calls this at all), this function never resolves it itself.
 * That keeps this trivially testable with the fake provider and keeps
 * the "unavailable" (no provider configured) state a caller-side
 * decision, the same way the webhook route handles it
 * (src/app/api/webhooks/wallet/[orgSlug]/route.ts).
 */
export async function getWalletBalances(
  organizationId: string,
  walletId: string,
  provider: WalletProvider,
): Promise<WalletBalancesResult> {
  const wallet = await getWallet(organizationId, walletId);

  if (wallet.status !== "ACTIVE") return { status: "not_connected" };

  try {
    const balances = await provider.getBalances(wallet.network as WalletNetwork, wallet.address);
    return { status: "ok", balances };
  } catch {
    return { status: "error" };
  }
}
