import { prisma } from "@/server/db/client";
import type { Currency } from "@/server/ar/currency";
import { formatMoney } from "@/server/ar/money";

/**
 * Phase 16 "what changed" — every item here comes from a real, already-
 * persisted timestamp (Payment.createdAt, BusinessEvent.detectedAt,
 * ActivityEvent.createdAt); nothing is inferred or invented. Reuses
 * BusinessEvent.detectedAt as "when this became a fact" rather than
 * introducing a new change-log table — INVOICE_OVERDUE/
 * INVOICE_RISK_ESCALATED rows are themselves already a timestamped record
 * of a state transition. See
 * docs/proactive-financial-operations.md#what-changed.
 */
export type ChangeItem = {
  kind: "payment_received" | "invoice_overdue" | "invoice_risk_escalated" | "action_executed";
  description: string;
};

const DEFAULT_LOOKBACK_HOURS = 24;

export async function getWhatChanged(
  organizationId: string,
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
): Promise<ChangeItem[]> {
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const [payments, newlyOverdue, riskEscalations, executedProposals] = await Promise.all([
    prisma.payment.findMany({
      where: { organizationId, createdAt: { gte: since } },
      include: { invoice: { select: { currency: true } } },
    }),
    prisma.businessEvent.count({
      where: { organizationId, type: "INVOICE_OVERDUE", detectedAt: { gte: since } },
    }),
    prisma.businessEvent.findMany({
      where: { organizationId, type: "INVOICE_RISK_ESCALATED", detectedAt: { gte: since } },
      select: { data: true },
    }),
    prisma.activityEvent.count({
      where: { organizationId, type: "ACTION_PROPOSAL_EXECUTED", createdAt: { gte: since } },
    }),
  ]);

  const items: ChangeItem[] = [];

  const paidByCurrency = new Map<Currency, bigint>();
  for (const payment of payments) {
    const currency = payment.invoice.currency as Currency;
    paidByCurrency.set(currency, (paidByCurrency.get(currency) ?? 0n) + payment.amountMinor);
  }
  for (const [currency, totalMinor] of paidByCurrency) {
    items.push({
      kind: "payment_received",
      description: `${formatMoney(totalMinor, currency)} received across ${payments.filter((p) => (p.invoice.currency as Currency) === currency).length} payment(s)`,
    });
  }

  if (newlyOverdue > 0) {
    items.push({
      kind: "invoice_overdue",
      description: `${newlyOverdue} invoice${newlyOverdue === 1 ? "" : "s"} became overdue`,
    });
  }

  const highRiskCount = riskEscalations.filter((e) => (e.data as { bucket?: string }).bucket === "HIGH").length;
  if (highRiskCount > 0) {
    items.push({
      kind: "invoice_risk_escalated",
      description: `${highRiskCount} invoice${highRiskCount === 1 ? "" : "s"} escalated to high risk`,
    });
  }

  if (executedProposals > 0) {
    items.push({
      kind: "action_executed",
      description: `${executedProposals} recommended action${executedProposals === 1 ? "" : "s"} sent`,
    });
  }

  return items;
}
