import { Prisma, type ActionProposal, type ActionType, type OperatorInsight } from "@prisma/client";

import { prisma } from "@/server/db/client";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/**
 * The server-side allowlist. `ActionType` (prisma/schema.prisma) currently
 * only has one member, so this looks redundant with the enum — the point
 * is that adding a new value to the enum in a future phase does not, by
 * itself, make the pipeline propose it. A new action type must be added
 * here explicitly, deliberately, by a human editing this file — it can
 * never be introduced by an AI response, which is never asked for (and
 * never validated to allow) a `type` field at all. See
 * docs/operator-foundation.md#action-safety.
 */
const ALLOWED_ACTION_TYPES: readonly ActionType[] = ["SEND_PAYMENT_REMINDER"];

function assertAllowedActionType(type: ActionType): void {
  if (!ALLOWED_ACTION_TYPES.includes(type)) {
    throw new Error(`Action type "${type}" is not allowlisted for proposal creation`);
  }
}

/**
 * Suggested tone is a deterministic function of priority — never an AI
 * output — so a proposal's suggested action is always reproducible from
 * data already in the database, even if the insight that produced it used
 * an AI-generated summary. See src/server/operator/insights.ts for why
 * priority itself is always deterministic.
 */
function suggestedToneForPriority(priority: OperatorInsight["priority"]): string {
  switch (priority) {
    case "HIGH":
      return "firm";
    case "MEDIUM":
      return "professional";
    case "LOW":
      return "friendly";
  }
}

export type EnsuredProposal = { proposal: ActionProposal; created: boolean };

/**
 * Idempotent: a second call for the same insight finds the existing row
 * via the unique constraint on [organizationId, insightId, type] rather
 * than creating a duplicate. In Phase 3 every OperatorInsight maps to
 * exactly one proposal type (SEND_PAYMENT_REMINDER) — later phases that
 * add more insight sources or action types extend this mapping, they
 * don't change how idempotency works.
 */
export async function ensureReminderProposalForInsight(
  organizationId: string,
  insight: OperatorInsight,
): Promise<EnsuredProposal> {
  const type: ActionType = "SEND_PAYMENT_REMINDER";
  assertAllowedActionType(type);

  try {
    const proposal = await prisma.actionProposal.create({
      data: {
        organizationId,
        insightId: insight.id,
        customerId: insight.customerId,
        invoiceId: insight.invoiceId,
        type,
        reasoning: insight.summary,
        suggestedTone: suggestedToneForPriority(insight.priority),
      },
    });
    return { proposal, created: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_CONSTRAINT_VIOLATION
    ) {
      const existing = await prisma.actionProposal.findUniqueOrThrow({
        where: { organizationId_insightId_type: { organizationId, insightId: insight.id, type } },
      });
      return { proposal: existing, created: false };
    }
    throw error;
  }
}
