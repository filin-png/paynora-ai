import { prisma } from "@/server/db/client";
import { recordActivityEvent } from "@/server/ar/activity";
import { computeInvoiceFinancials, getPaidMinorForInvoice } from "@/server/ar/invoices";

/**
 * Phase 16 — a PENDING proposal whose underlying situation has already
 * resolved (the invoice was paid, cancelled, or is no longer overdue)
 * before a human decided. Never silently executed or deleted — this only
 * ever transitions PENDING -> STALE, the same atomic compare-and-swap
 * pattern as approve/dismiss (src/server/operator/approval.ts), so a
 * human decision that races with this check always wins: `updateMany`'s
 * `WHERE ... AND status = 'PENDING'` matches zero rows once the human's
 * transaction commits first, and this function silently skips that
 * proposal rather than overwriting a real decision.
 *
 * Only proposals tied to a specific invoice are ever eligible — a
 * proposal with no invoiceId (none exist yet; SEND_PAYMENT_REMINDER is
 * the only ActionType, and it always has one) has nothing to re-check
 * against.
 */
export async function markStaleActionProposals(organizationId: string): Promise<{ markedStale: number }> {
  const pending = await prisma.actionProposal.findMany({
    where: { organizationId, status: "PENDING", invoiceId: { not: null } },
    select: { id: true, invoiceId: true },
  });

  let markedStale = 0;
  for (const proposal of pending) {
    const invoice = await prisma.invoice.findFirst({
      where: { id: proposal.invoiceId!, organizationId },
    });
    if (!invoice) continue;

    const paidMinor = await getPaidMinorForInvoice(invoice.id);
    const financials = computeInvoiceFinancials(invoice, paidMinor);
    const isStale = invoice.status === "CANCELLED" || financials.isPaid || !financials.isOverdue;
    if (!isStale) continue;

    if (await transitionToStale(organizationId, proposal.id)) {
      markedStale += 1;
    }
  }

  return { markedStale };
}

async function transitionToStale(organizationId: string, proposalId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.actionProposal.updateMany({
      where: { id: proposalId, organizationId, status: "PENDING" },
      data: { status: "STALE", decidedAt: new Date() },
    });
    if (result.count !== 1) return false;

    const updated = await tx.actionProposal.findUniqueOrThrow({ where: { id: proposalId } });
    await recordActivityEvent(tx, {
      organizationId,
      type: "ACTION_PROPOSAL_MARKED_STALE",
      summary: `Payment reminder proposal automatically marked stale for invoice ${updated.invoiceId ?? "unknown"} — the underlying invoice is no longer overdue`,
      customerId: updated.customerId ?? undefined,
      invoiceId: updated.invoiceId ?? undefined,
    });
    return true;
  });
}
