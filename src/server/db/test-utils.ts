import { prisma } from "./client";

/**
 * Deletes all rows between tests. Deletion order follows foreign keys
 * explicitly rather than relying on cascade, so this keeps working if a
 * future model's cascade behavior changes (several Phase 2 relations are
 * intentionally RESTRICT, not CASCADE — see docs/accounts-receivable.md).
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.deliveryAttempt.deleteMany(),
    prisma.communication.deleteMany(),
    prisma.collectionStepExecution.deleteMany(),
    prisma.actionProposal.deleteMany(),
    prisma.operatorInsight.deleteMany(),
    prisma.businessEvent.deleteMany(),
    prisma.collectionSequence.deleteMany(),
    prisma.collectionPolicyStep.deleteMany(),
    prisma.collectionPolicy.deleteMany(),
    prisma.activityEvent.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.organizationMember.deleteMany(),
    prisma.organization.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}
