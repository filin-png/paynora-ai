import { prisma } from "@/server/db/client";

/**
 * Phase 16 "financial memory" — an outcome/event history, never machine
 * learning. Every field here is derived at read time from timestamps
 * already in the database (ActionProposal.decidedAt, Payment.createdAt);
 * nothing is persisted or trained. Language is deliberately neutral:
 * "payment received after action," never "action caused the payment" —
 * see docs/proactive-financial-operations.md#outcomes-and-effectiveness
 * for why causality is never claimed.
 */
export type ActionOutcome =
  | { status: "pending-decision" }
  | { status: "dismissed" }
  | { status: "stale" }
  | { status: "approved-not-yet-executed" }
  | { status: "executed-no-payment-yet" }
  | { status: "executed-payment-received-after"; daysToPayment: number };

export async function getActionOutcome(proposalId: string, organizationId: string): Promise<ActionOutcome> {
  const proposal = await prisma.actionProposal.findFirst({
    where: { id: proposalId, organizationId },
    select: { status: true, decidedAt: true, invoiceId: true },
  });
  if (!proposal) return { status: "pending-decision" };

  if (proposal.status === "PENDING") return { status: "pending-decision" };
  if (proposal.status === "DISMISSED") return { status: "dismissed" };
  if (proposal.status === "STALE") return { status: "stale" };
  if (proposal.status === "APPROVED") return { status: "approved-not-yet-executed" };

  // EXECUTED
  if (!proposal.invoiceId || !proposal.decidedAt) return { status: "executed-no-payment-yet" };
  const paymentAfter = await prisma.payment.findFirst({
    where: { invoiceId: proposal.invoiceId, createdAt: { gt: proposal.decidedAt } },
    orderBy: { createdAt: "asc" },
  });
  if (!paymentAfter) return { status: "executed-no-payment-yet" };

  const daysToPayment = Math.round(
    (paymentAfter.createdAt.getTime() - proposal.decidedAt.getTime()) / 86_400_000,
  );
  return { status: "executed-payment-received-after", daysToPayment };
}

export type RecommendationEffectiveness = {
  totalProposals: number;
  pending: number;
  approved: number;
  dismissed: number;
  stale: number;
  executed: number;
  /** Of the executed proposals, how many had a payment recorded after the decision — never claimed as caused by the action. */
  executedWithPaymentAfter: number;
  /** Average days from decision to that payment, across executedWithPaymentAfter only — null when there is no such data yet. */
  averageDaysToPaymentAfterAction: number | null;
};

/**
 * One bulk query for every EXECUTED proposal's invoice + payments (never
 * one query per proposal) — the same "single org-wide query, compute
 * locally" pattern used throughout this codebase's AR summary layer.
 */
export async function getRecommendationEffectiveness(organizationId: string): Promise<RecommendationEffectiveness> {
  const proposals = await prisma.actionProposal.findMany({
    where: { organizationId },
    select: { status: true, decidedAt: true, invoiceId: true },
  });

  const counts = { pending: 0, approved: 0, dismissed: 0, stale: 0, executed: 0 };
  const executedProposals: { decidedAt: Date; invoiceId: string }[] = [];
  for (const p of proposals) {
    switch (p.status) {
      case "PENDING":
        counts.pending += 1;
        break;
      case "APPROVED":
        counts.approved += 1;
        break;
      case "DISMISSED":
        counts.dismissed += 1;
        break;
      case "STALE":
        counts.stale += 1;
        break;
      case "EXECUTED":
        counts.executed += 1;
        if (p.decidedAt && p.invoiceId) executedProposals.push({ decidedAt: p.decidedAt, invoiceId: p.invoiceId });
        break;
      case "FAILED":
        break;
    }
  }

  const invoiceIds = executedProposals.map((p) => p.invoiceId);
  const payments =
    invoiceIds.length > 0
      ? await prisma.payment.findMany({
          where: { invoiceId: { in: invoiceIds } },
          select: { invoiceId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
  const paymentsByInvoice = new Map<string, { createdAt: Date }[]>();
  for (const payment of payments) {
    const existing = paymentsByInvoice.get(payment.invoiceId) ?? [];
    existing.push({ createdAt: payment.createdAt });
    paymentsByInvoice.set(payment.invoiceId, existing);
  }

  let executedWithPaymentAfter = 0;
  const daysToPaymentValues: number[] = [];
  for (const p of executedProposals) {
    // `payments` is already ordered by createdAt asc, so the first entry
    // per invoice that is strictly after decidedAt is the earliest one.
    const earliestAfter = (paymentsByInvoice.get(p.invoiceId) ?? []).find((pay) => pay.createdAt > p.decidedAt);
    if (earliestAfter) {
      executedWithPaymentAfter += 1;
      daysToPaymentValues.push(Math.round((earliestAfter.createdAt.getTime() - p.decidedAt.getTime()) / 86_400_000));
    }
  }

  return {
    totalProposals: proposals.length,
    pending: counts.pending,
    approved: counts.approved,
    dismissed: counts.dismissed,
    stale: counts.stale,
    executed: counts.executed,
    executedWithPaymentAfter,
    averageDaysToPaymentAfterAction:
      daysToPaymentValues.length > 0
        ? Math.round((daysToPaymentValues.reduce((a, b) => a + b, 0) / daysToPaymentValues.length) * 10) / 10
        : null,
  };
}
