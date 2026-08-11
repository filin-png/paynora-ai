import type { ActionProposal, ActionProposalStatus } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordActivityEvent } from "@/server/ar/activity";
import { InvalidActionProposalTransitionError, OperatorResourceNotFoundError } from "./errors";

async function getTenantProposal(organizationId: string, proposalId: string): Promise<ActionProposal> {
  const proposal = await prisma.actionProposal.findFirst({
    where: { id: proposalId, organizationId },
  });
  if (!proposal) throw new OperatorResourceNotFoundError("Action proposal");
  return proposal;
}

/**
 * PENDING is the only status either transition may start from — every
 * other starting status either returns the current row unchanged (calling
 * approve on an already-APPROVED proposal, or dismiss on an
 * already-DISMISSED one — safe to repeat, e.g. a doubled click) or throws
 * (approve on DISMISSED, dismiss on APPROVED, or anything on
 * EXECUTED/FAILED). There is no path that silently flips DISMISSED to
 * APPROVED or back — see docs/operator-foundation.md#approval-workflow.
 */
function assertTransition(current: ActionProposalStatus, target: ActionProposalStatus): "apply" | "noop" {
  if (current === target) return "noop";
  if (current !== "PENDING") throw new InvalidActionProposalTransitionError(current, target);
  return "apply";
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
  const proposal = await getTenantProposal(organizationId, proposalId);
  if (assertTransition(proposal.status, "APPROVED") === "noop") return proposal;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.actionProposal.update({
      where: { id: proposal.id },
      data: { status: "APPROVED", decidedAt: new Date(), decidedByUserId: userId },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "ACTION_PROPOSAL_APPROVED",
      summary: `Payment reminder proposal approved for invoice ${updated.invoiceId ?? "unknown"}`,
      customerId: updated.customerId ?? undefined,
      invoiceId: updated.invoiceId ?? undefined,
    });
    return updated;
  });
}

export async function dismissActionProposal(
  organizationId: string,
  proposalId: string,
  userId: string,
): Promise<ActionProposal> {
  const proposal = await getTenantProposal(organizationId, proposalId);
  if (assertTransition(proposal.status, "DISMISSED") === "noop") return proposal;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.actionProposal.update({
      where: { id: proposal.id },
      data: { status: "DISMISSED", decidedAt: new Date(), decidedByUserId: userId },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "ACTION_PROPOSAL_DISMISSED",
      summary: `Payment reminder proposal dismissed for invoice ${updated.invoiceId ?? "unknown"}`,
      customerId: updated.customerId ?? undefined,
      invoiceId: updated.invoiceId ?? undefined,
    });
    return updated;
  });
}

/**
 * Highest priority first. Relies on Postgres sorting a native enum by its
 * declaration order (LOW, MEDIUM, HIGH — see prisma/schema.prisma), not
 * alphabetically, so `desc` puts HIGH first — verified in
 * approval.test.ts, not just assumed.
 */
export async function listPendingActionProposals(organizationId: string) {
  return prisma.actionProposal.findMany({
    where: { organizationId, status: "PENDING" },
    include: { invoice: { include: { customer: true } }, customer: true, insight: true },
    orderBy: [{ insight: { priority: "desc" } }, { createdAt: "asc" }],
  });
}

const RECENTLY_DECIDED_LIMIT = 20;

/**
 * Proposals a human has already approved or dismissed, most recent first —
 * shown alongside the pending list so the Action Center stays honest about
 * what happened to a decision instead of the row just disappearing. See
 * docs/operator-foundation.md#action-center-ui.
 */
export async function listRecentlyDecidedActionProposals(organizationId: string, take = RECENTLY_DECIDED_LIMIT) {
  return prisma.actionProposal.findMany({
    where: { organizationId, status: { in: ["APPROVED", "DISMISSED"] } },
    include: { invoice: { include: { customer: true } }, customer: true, insight: true },
    orderBy: { decidedAt: "desc" },
    take,
  });
}
