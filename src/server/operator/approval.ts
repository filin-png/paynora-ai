import type { ActionProposal, ActivityEventType } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordActivityEvent } from "@/server/ar/activity";
import { InvalidActionProposalTransitionError, OperatorResourceNotFoundError } from "./errors";

/**
 * Single tenant-scoped proposal lookup with the context the Action Center
 * detail page (`/app/[orgSlug]/actions/[proposalId]`) needs to render a
 * review/send flow — see src/server/communications/draft.ts for how a
 * SEND_PAYMENT_REMINDER proposal becomes a Communication.
 */
export async function getActionProposal(organizationId: string, proposalId: string) {
  const proposal = await prisma.actionProposal.findFirst({
    where: { id: proposalId, organizationId },
    include: { invoice: { include: { customer: true } }, customer: true, insight: true },
  });
  if (!proposal) throw new OperatorResourceNotFoundError("Action proposal");
  return proposal;
}

const DECISION_LABEL: Record<"APPROVED" | "DISMISSED", string> = {
  APPROVED: "approved",
  DISMISSED: "dismissed",
};

const DECISION_ACTIVITY_TYPE: Record<"APPROVED" | "DISMISSED", ActivityEventType> = {
  APPROVED: "ACTION_PROPOSAL_APPROVED",
  DISMISSED: "ACTION_PROPOSAL_DISMISSED",
};

/**
 * Atomic compare-and-swap: `updateMany` compiles to a single
 * `UPDATE ... WHERE id = $1 AND organizationId = $2 AND status = 'PENDING'`
 * statement. Postgres locks the target row as part of evaluating that
 * WHERE clause, so two concurrent calls for the same proposal (one
 * approve, one dismiss) serialize on the row: whichever transaction's
 * UPDATE reaches the row first proceeds and commits; the second blocks
 * until the first commits, then — under Postgres's default READ COMMITTED
 * isolation, an UPDATE re-evaluates its WHERE clause against the
 * just-committed row before applying (Postgres's "EvalPlanQual"
 * behavior) — finds `status` is no longer `'PENDING'`, and matches zero
 * rows instead of overwriting the winner's decision. `result.count` tells
 * us which happened without a separate SELECT-then-UPDATE window: this
 * is the same class of fix as `lockInvoiceForUpdate` in
 * src/server/ar/invoices.ts (Phase 2's cancelInvoice/recordPayment race),
 * expressed as a conditional UPDATE instead of `SELECT ... FOR UPDATE`
 * because the precondition here is the row's own current column, not a
 * separately-computed aggregate. See
 * docs/operator-foundation.md#approval-workflow and
 * src/server/operator/approval.test.ts for a real concurrent
 * approve-vs-dismiss test proving the invariant holds regardless of which
 * one wins.
 *
 * PENDING is the only status either transition may start from — every
 * other starting status either returns the current row unchanged (calling
 * approve on an already-APPROVED proposal, or dismiss on an
 * already-DISMISSED one — safe to repeat, e.g. a doubled click) or throws
 * (approve on DISMISSED, dismiss on APPROVED, or anything on
 * EXECUTED/FAILED). There is no path that silently flips DISMISSED to
 * APPROVED or back — see docs/operator-foundation.md#approval-workflow.
 */
async function transitionActionProposal(
  organizationId: string,
  proposalId: string,
  userId: string,
  target: "APPROVED" | "DISMISSED",
): Promise<ActionProposal> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.actionProposal.updateMany({
      where: { id: proposalId, organizationId, status: "PENDING" },
      data: { status: target, decidedAt: new Date(), decidedByUserId: userId },
    });

    if (result.count === 1) {
      // We won the compare-and-swap: this call is the one that actually
      // applied the decision, so this is the one call that audits it.
      const updated = await tx.actionProposal.findUniqueOrThrow({ where: { id: proposalId } });
      await recordActivityEvent(tx, {
        organizationId,
        type: DECISION_ACTIVITY_TYPE[target],
        summary: `Payment reminder proposal ${DECISION_LABEL[target]} for invoice ${updated.invoiceId ?? "unknown"}`,
        customerId: updated.customerId ?? undefined,
        invoiceId: updated.invoiceId ?? undefined,
      });
      return updated;
    }

    // Either the row doesn't exist/belong to this org, it's already in the
    // target state (idempotent no-op — e.g. a doubled click), or it's in a
    // conflicting state (lost the race, or a genuinely invalid transition).
    const current = await tx.actionProposal.findFirst({
      where: { id: proposalId, organizationId },
    });
    if (!current) throw new OperatorResourceNotFoundError("Action proposal");
    if (current.status === target) return current;
    throw new InvalidActionProposalTransitionError(current.status, target);
  });
}

/**
 * Approving a proposal in Phase 3 only ever changes its status — there is
 * no execution path yet (SECURITY.md, docs/operator-foundation.md). The
 * Action Center UI is explicit about this; nothing here sends anything.
 */
export async function approveActionProposal(
  organizationId: string,
  proposalId: string,
  userId: string,
): Promise<ActionProposal> {
  return transitionActionProposal(organizationId, proposalId, userId, "APPROVED");
}

export async function dismissActionProposal(
  organizationId: string,
  proposalId: string,
  userId: string,
): Promise<ActionProposal> {
  return transitionActionProposal(organizationId, proposalId, userId, "DISMISSED");
}

/**
 * Highest priority first. Relies on Postgres sorting a native enum by its
 * declaration order (LOW, MEDIUM, HIGH — see prisma/schema.prisma), not
 * alphabetically, so `desc` puts HIGH first — verified in
 * approval.test.ts, not just assumed.
 */
const PENDING_PROPOSALS_LIMIT = 500;

export async function listPendingActionProposals(organizationId: string) {
  return prisma.actionProposal.findMany({
    where: { organizationId, status: "PENDING" },
    include: { invoice: { include: { customer: true } }, customer: true, insight: true },
    orderBy: [{ insight: { priority: "desc" } }, { createdAt: "asc" }],
    // Defensive cap, not real pagination — see
    // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P2-3. Pending proposals
    // are naturally self-limiting (they leave this list once approved or
    // dismissed); this only guards a badly neglected organization.
    take: PENDING_PROPOSALS_LIMIT,
  });
}

const RECENTLY_DECIDED_LIMIT = 20;

/**
 * Proposals a human has already approved, dismissed, or (Phase 4) sent,
 * most recent first — shown alongside the pending list so the Action
 * Center stays honest about what happened to a decision instead of the
 * row just disappearing. See docs/operator-foundation.md#action-center-ui
 * and docs/communications.md for the APPROVED -> ... -> EXECUTED path.
 *
 * Also includes STALE (Phase 16, src/server/operator/stale.ts) — a
 * proposal the system itself resolved (the underlying invoice was paid or
 * is no longer overdue before a human decided), not a human decision, but
 * the same "never let a row just disappear" principle applies to it too.
 */
export async function listRecentlyDecidedActionProposals(organizationId: string, take = RECENTLY_DECIDED_LIMIT) {
  return prisma.actionProposal.findMany({
    where: { organizationId, status: { in: ["APPROVED", "DISMISSED", "EXECUTED", "STALE"] } },
    include: { invoice: { include: { customer: true } }, customer: true, insight: true },
    orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
    take,
  });
}
