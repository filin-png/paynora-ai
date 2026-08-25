import { env, type Env } from "@/lib/env";
import { WalletDisabledError, WalletProviderNotImplementedError } from "./errors";
import type { WalletProvider } from "./provider-types";

/** True when `WALLET_PROVIDER` selects anything other than "none". */
export function isWalletEnabled(): boolean {
  return env.WALLET_PROVIDER !== "none";
}

/**
 * Resolves the WalletProvider for the configured `WALLET_PROVIDER` — the
 * one place that knows Coinbase/Privy (or any future wallet vendor) exist.
 * Mirrors src/server/billing/service.ts#resolveBillingProvider exactly:
 * "coinbase"/"privy" are recognized but have no real adapter yet (no
 * production credentials in this phase — see
 * docs/wallet-architecture.md#production-integration-point); selecting
 * either resolves to a clear, typed error rather than silently doing
 * nothing.
 */
export function resolveWalletProvider(name: Env["WALLET_PROVIDER"] = env.WALLET_PROVIDER): WalletProvider {
  if (name === "none") throw new WalletDisabledError();
  throw new WalletProviderNotImplementedError(name);
}
