import { z } from "zod";

/**
 * Allowlisted, not free-text — mirrors src/server/ar/currency.ts's
 * SUPPORTED_CURRENCIES exactly, and for the same reason: a typo'd network
 * name would silently break every match/reconciliation query that groups
 * by network. `Wallet.network`/`WalletTransaction.network` are plain string
 * columns (see docs/wallet-architecture.md#wallet-domain), so recognizing a
 * new chain is a one-line change here, never a migration.
 */
export const SUPPORTED_NETWORKS = ["ETHEREUM", "BITCOIN", "TRON", "SOLANA", "POLYGON", "BSC"] as const;

export type WalletNetwork = (typeof SUPPORTED_NETWORKS)[number];

export const walletNetworkSchema = z.enum(SUPPORTED_NETWORKS);

export function isSupportedNetwork(value: string): value is WalletNetwork {
  return (SUPPORTED_NETWORKS as readonly string[]).includes(value);
}

/**
 * Allowlisted asset symbols this phase recognizes — deliberately small.
 * Like SUPPORTED_NETWORKS, this is a domain-layer allowlist over a plain
 * string column, not a schema enum, so adding an asset never requires a
 * migration. Assets are not modeled as their own table in this phase (no
 * per-asset metadata beyond `assetDecimals`, which each caller supplies
 * explicitly) — see docs/wallet-architecture.md#known-limitations.
 */
export const SUPPORTED_ASSETS = ["BTC", "ETH", "USDT", "USDC", "SOL", "TRX"] as const;

export type WalletAsset = (typeof SUPPORTED_ASSETS)[number];

export const walletAssetSchema = z.enum(SUPPORTED_ASSETS);

export function isSupportedAsset(value: string): value is WalletAsset {
  return (SUPPORTED_ASSETS as readonly string[]).includes(value);
}
