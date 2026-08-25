/**
 * Thrown for any Wallet-domain resource (Wallet, CryptoPaymentRequest,
 * WalletTransaction) looked up by id that either doesn't exist or doesn't
 * belong to the calling organization — same enumeration-safety reasoning
 * as ArResourceNotFoundError (src/server/ar/errors.ts): a cross-tenant id
 * must never get a different response than a nonexistent one.
 */
export class WalletResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "WalletResourceNotFoundError";
  }
}

/**
 * A Wallet connect/verify/disconnect call, or a CryptoPaymentRequest
 * create/cancel call, was attempted from a status that doesn't allow it —
 * see docs/wallet-architecture.md#wallet-lifecycle. Shared by both models
 * rather than duplicated per-model, the same way ArResourceNotFoundError
 * covers Customer/Invoice/Payment.
 */
export class InvalidWalletTransitionError extends Error {
  constructor(from: string, message: string) {
    super(`Invalid wallet operation from status ${from}: ${message}`);
    this.name = "InvalidWalletTransitionError";
  }
}

/** A WalletTransaction status update was attempted with an illegal transition — see src/server/wallet/transaction-state-machine.ts. */
export class InvalidWalletTransactionTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid wallet transaction transition: ${from} -> ${to}`);
    this.name = "InvalidWalletTransactionTransitionError";
  }
}

/** Two wallets with the same (network, address) — a real on-chain address can only ever be watched once, by one organization. */
export class DuplicateWalletAddressError extends Error {
  constructor() {
    super("This address is already connected as a wallet");
    this.name = "DuplicateWalletAddressError";
  }
}

/**
 * A webhook delivery failed authenticity verification (bad/missing
 * signature) — mirrors BillingWebhookVerificationError
 * (src/server/billing/errors.ts). Never includes the raw signature,
 * secret, or full request body in this error's message.
 */
export class WalletWebhookVerificationError extends Error {
  constructor(provider: string) {
    super(`Wallet provider "${provider}" webhook failed signature verification`);
    this.name = "WalletWebhookVerificationError";
  }
}

/** Wallet features are turned off (WALLET_PROVIDER=none, the default) or have no configured provider. */
export class WalletDisabledError extends Error {
  constructor() {
    super("Wallet features are disabled (WALLET_PROVIDER=none)");
    this.name = "WalletDisabledError";
  }
}

/** A wallet vendor is recognized (selectable via WALLET_PROVIDER) but has no real adapter yet — same precedent as BillingProviderNotImplementedError. */
export class WalletProviderNotImplementedError extends Error {
  constructor(provider: string) {
    super(`Wallet provider "${provider}" is not implemented yet — see docs/wallet-architecture.md#production-integration-point`);
    this.name = "WalletProviderNotImplementedError";
  }
}

/** createCryptoPaymentRequest was asked to settle more than the invoice's current outstanding balance. */
export class ExceedsOutstandingBalanceError extends Error {
  constructor(outstandingMinor: bigint) {
    super(`Requested amount exceeds the invoice's outstanding balance (${outstandingMinor} minor units remaining)`);
    this.name = "ExceedsOutstandingBalanceError";
  }
}
