import { WalletDisabledError } from "../errors";
import type {
  RawWalletEvent,
  WalletBalance,
  WalletConnectionRequest,
  WalletConnectionResult,
  WalletOwnershipVerification,
  WalletProvider,
} from "../provider-types";
import type { WalletNetwork } from "../network";

/**
 * The default provider when WALLET_PROVIDER=none (src/lib/env.ts) —
 * mirrors src/server/billing/providers/none.ts and
 * src/server/messaging/providers/none.ts. Every call fails the same
 * documented way, so "no provider configured" is a real, testable object
 * rather than a null check scattered across callers.
 */
export const noneWalletProvider: WalletProvider = {
  name: "none",
  connectWallet(_request: WalletConnectionRequest): Promise<WalletConnectionResult> {
    throw new WalletDisabledError();
  },
  verifyOwnership(_network: WalletNetwork, _address: string, _proof: unknown): Promise<WalletOwnershipVerification> {
    throw new WalletDisabledError();
  },
  getBalances(_network: WalletNetwork, _address: string): Promise<WalletBalance[]> {
    throw new WalletDisabledError();
  },
  inspectTransaction(_network: WalletNetwork, _txHash: string): Promise<RawWalletEvent | null> {
    throw new WalletDisabledError();
  },
  verifyAndParseWebhookEvent(_rawBody: string, _signatureHeader: string): RawWalletEvent {
    throw new WalletDisabledError();
  },
};
