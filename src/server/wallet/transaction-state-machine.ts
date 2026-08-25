import type { WalletTransactionStatus } from "@prisma/client";

import { InvalidWalletTransactionTransitionError } from "./errors";

/**
 * DETECTED -> CONFIRMING -> CONFIRMED, with FAILED/EXPIRED as failure
 * paths — see the WalletTransactionStatus schema doc comment for why this
 * shape was derived from the actual requirement rather than copied from a
 * generic template. DETECTED and CONFIRMING both allow a self-loop: a
 * provider may deliver several events for the same transaction while it's
 * still below its confirmation threshold (increasing `confirmations` each
 * time) without that being a meaningful status *change*. CONFIRMED,
 * FAILED, and EXPIRED are terminal — nothing transitions out of them,
 * which is what makes a late/out-of-order webhook delivery arriving after
 * a transaction has already reached one of those states safely rejected
 * rather than silently overwriting an authoritative outcome (see
 * src/server/wallet/transactions.ts's ingestion pipeline, which catches
 * exactly this and treats it as a no-op replay).
 */
const ALLOWED_TRANSITIONS: Record<WalletTransactionStatus, readonly WalletTransactionStatus[]> = {
  DETECTED: ["DETECTED", "CONFIRMING", "CONFIRMED", "FAILED", "EXPIRED"],
  CONFIRMING: ["CONFIRMING", "CONFIRMED", "FAILED", "EXPIRED"],
  CONFIRMED: [],
  FAILED: [],
  EXPIRED: [],
};

export function isValidWalletTransactionTransition(
  from: WalletTransactionStatus,
  to: WalletTransactionStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Throws InvalidWalletTransactionTransitionError for any transition not in ALLOWED_TRANSITIONS above — illegal transitions are always rejected, never silently applied. */
export function assertValidWalletTransactionTransition(
  from: WalletTransactionStatus,
  to: WalletTransactionStatus,
): void {
  if (!isValidWalletTransactionTransition(from, to)) {
    throw new InvalidWalletTransactionTransitionError(from, to);
  }
}
