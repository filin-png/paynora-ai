import type { BadgeProps } from "@/components/ui/badge";
import type { Dictionary } from "@/lib/i18n";

/** "0x1234...abcd" — never truncated so badly it stops being a recognizable identifier, but short enough for a table cell. */
export function shortenAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

export const WALLET_STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  PENDING_VERIFICATION: "warning",
  ACTIVE: "success",
  DISCONNECTED: "neutral",
};

export function walletStatusLabel(t: Dictionary["wallet"]): Record<string, string> {
  return {
    PENDING_VERIFICATION: t.statusPendingVerification,
    ACTIVE: t.statusActive,
    DISCONNECTED: t.statusDisconnected,
  };
}

export const TRANSACTION_STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  DETECTED: "neutral",
  CONFIRMING: "info",
  CONFIRMED: "success",
  FAILED: "danger",
  EXPIRED: "neutral",
};

export function transactionStatusLabel(t: Dictionary["wallet"]): Record<string, string> {
  return {
    DETECTED: t.txStatusDetected,
    CONFIRMING: t.txStatusConfirming,
    CONFIRMED: t.txStatusConfirmed,
    FAILED: t.txStatusFailed,
    EXPIRED: t.txStatusExpired,
  };
}

export const RECONCILIATION_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  MATCHED: "success",
  REJECTED: "warning",
};

export function reconciliationLabel(t: Dictionary["wallet"], outcome: string | null, reason: string | null): string {
  if (!outcome) return t.reconciliationPending;
  if (outcome === "MATCHED") return t.reconciliationReconciled;
  return reason
    ? t.reconciliationNotReconciledReason.replace("{reason}", reason.toLowerCase().replaceAll("_", " "))
    : t.reconciliationNotReconciled;
}
