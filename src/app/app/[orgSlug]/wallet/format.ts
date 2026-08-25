import type { BadgeProps } from "@/components/ui/badge";

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

export const WALLET_STATUS_LABEL: Record<string, string> = {
  PENDING_VERIFICATION: "Pending verification",
  ACTIVE: "Active",
  DISCONNECTED: "Disconnected",
};

export const TRANSACTION_STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  DETECTED: "neutral",
  CONFIRMING: "info",
  CONFIRMED: "success",
  FAILED: "danger",
  EXPIRED: "neutral",
};

export const RECONCILIATION_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  MATCHED: "success",
  REJECTED: "warning",
};

export function reconciliationLabel(outcome: string | null, reason: string | null): string {
  if (!outcome) return "Pending";
  if (outcome === "MATCHED") return "Reconciled";
  return reason ? `Not reconciled — ${reason.toLowerCase().replaceAll("_", " ")}` : "Not reconciled";
}
