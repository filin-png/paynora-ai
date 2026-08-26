import { env } from "@/lib/env";
import { WalletDisabledError, WalletProviderNotImplementedError } from "./errors";
import { createAlchemyWalletProvider } from "./providers/alchemy";
import type { WalletProvider } from "./provider-types";

/** True when `WALLET_PROVIDER` selects anything other than "none". */
export function isWalletEnabled(): boolean {
  return env.WALLET_PROVIDER !== "none";
}

/**
 * Resolves the WalletProvider for the configured `WALLET_PROVIDER` — the
 * one place that knows Alchemy/Coinbase/Privy (or any future wallet
 * vendor) exist. Mirrors src/server/billing/service.ts#resolveBillingProvider:
 * "coinbase"/"privy" are recognized but have no real adapter yet; selecting
 * either resolves to a clear, typed error rather than silently doing
 * nothing. "alchemy" (Phase 14) has a real adapter — see
 * docs/production-integrations.md#wallet.
 */
export function resolveWalletProvider(): WalletProvider {
  if (env.WALLET_PROVIDER === "none") throw new WalletDisabledError();
  if (env.WALLET_PROVIDER === "alchemy") {
    // env.ts's superRefine guarantees these are set whenever this branch is reached.
    return createAlchemyWalletProvider({
      apiKey: env.ALCHEMY_API_KEY!,
      authToken: env.ALCHEMY_AUTH_TOKEN!,
      webhookId: env.ALCHEMY_WEBHOOK_ID!,
      webhookSigningKey: env.ALCHEMY_WEBHOOK_SIGNING_KEY!,
    });
  }
  throw new WalletProviderNotImplementedError(env.WALLET_PROVIDER);
}
