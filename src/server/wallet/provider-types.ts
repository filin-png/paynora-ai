/**
 * WalletProvider is the vendor-neutral boundary between PAYNORA's domain
 * layer and any real wallet/blockchain provider (Coinbase, Privy,
 * WalletConnect, a direct node/indexer integration, ...) — the "Provider
 * Registry -> Concrete Provider Adapter" box in the phase brief's diagram.
 * Domain code (src/server/wallet/*.ts) only ever calls through this
 * interface; it never knows which vendor, if any, is behind it. See
 * docs/wallet-architecture.md#provider-abstraction.
 *
 * Deliberately narrow, mirroring BillingProvider's discipline
 * (src/server/billing/types.ts): a WalletProvider observes and reports —
 * it never itself decides PAYNORA financial state. `connectWallet`/
 * `verifyOwnership` only ever produce a Wallet's *status*; reconciling a
 * transaction into an invoice Payment is always domain code
 * (src/server/wallet/reconciliation.ts), never a provider call.
 *
 * "Create payment request" from the phase brief's capability list is
 * deliberately NOT a method here — a payment request
 * (CryptoPaymentRequest) is a PAYNORA-domain concept tied to one invoice; a
 * wallet provider has no notion of a PAYNORA invoice at all. That
 * capability lives entirely in src/server/wallet/payment-requests.ts.
 */

import type { WalletNetwork } from "./network";

export type WalletConnectionRequest = {
  network: WalletNetwork;
  address: string;
  label?: string;
};

export type WalletConnectionResult = {
  /** Opaque, provider-assigned identifier for this connection, if the provider has one. Never a secret. */
  providerWalletId?: string;
};

export type WalletOwnershipVerification = {
  verified: boolean;
  /** Human-readable reason when verified is false — never a secret or raw provider payload. */
  reason?: string;
};

export type WalletBalance = {
  asset: string;
  assetDecimals: number;
  amountMinor: bigint;
};

export type WalletEventStatus = "DETECTED" | "CONFIRMING" | "CONFIRMED" | "FAILED";

/**
 * A real on-chain event, already verified and normalized by a
 * WalletProvider — never the raw vendor webhook payload. This is what
 * every provider adapter (real or test) must reduce its own event shape
 * to; see docs/wallet-architecture.md#webhook-pipeline for the full
 * ingestion pipeline this feeds into.
 */
export type RawWalletEvent = {
  /** Opaque provider-assigned event id, if any — for audit only, never the idempotency boundary (see WalletTransaction.@@unique([network, txHash])). */
  providerEventId?: string;
  network: WalletNetwork;
  txHash: string;
  direction: "INCOMING" | "OUTGOING";
  asset: string;
  assetDecimals: number;
  /** In the asset's own smallest unit (e.g. wei for ETH) — never a float. */
  amountMinor: bigint;
  fromAddress?: string;
  toAddress: string;
  status: WalletEventStatus;
  confirmations: number;
  requiredConfirmations: number;
  observedAt: Date;
  /** Safe, non-secret metadata only (e.g. block number, network fee) — never a private key, signing secret, or raw Authorization header. */
  metadata?: Record<string, unknown>;
};

export interface WalletProvider {
  readonly name: string;

  /** Registers a wallet address as one the provider should watch. Never returns or requires a private key or seed phrase. */
  connectWallet(request: WalletConnectionRequest): Promise<WalletConnectionResult>;

  /**
   * Verifies that whoever connected this wallet actually controls it (e.g.
   * a signed-message challenge) — `proof` is provider-specific and opaque
   * to domain code. Returns a result rather than throwing on a failed
   * proof (a failed verification is an expected, recoverable outcome, not
   * an exceptional one); throws only for a provider/transport failure.
   */
  verifyOwnership(network: WalletNetwork, address: string, proof: unknown): Promise<WalletOwnershipVerification>;

  getBalances(network: WalletNetwork, address: string): Promise<WalletBalance[]>;

  /** Looks up one transaction by hash directly (not via a webhook) — used for on-demand "inspect transaction" / manual verification. Returns null if the provider has no record of it. */
  inspectTransaction(network: WalletNetwork, txHash: string): Promise<RawWalletEvent | null>;

  /**
   * Verifies a webhook delivery's authenticity (provider-specific
   * signature scheme) and parses it into a RawWalletEvent — mirrors
   * BillingProvider.verifyAndParseWebhook exactly. Must throw
   * WalletWebhookVerificationError — never return a best-guess result —
   * when verification fails; a forged webhook must never reach domain
   * code labeled as legitimate. See docs/wallet-architecture.md#webhook-security.
   */
  verifyAndParseWebhookEvent(rawBody: string, signatureHeader: string): RawWalletEvent;
}
