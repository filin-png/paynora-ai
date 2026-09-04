import { prisma } from "./client";

/**
 * Deletes all rows between tests. Deletion order follows foreign keys
 * explicitly rather than relying on cascade, so this keeps working if a
 * future model's cascade behavior changes (several Phase 2 relations are
 * intentionally RESTRICT, not CASCADE — see docs/accounts-receivable.md).
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.rateLimitCounter.deleteMany(),
    prisma.automationTickRun.deleteMany(),
    prisma.passwordResetToken.deleteMany(),
    prisma.organizationInvitation.deleteMany(),
    prisma.organizationSubscription.deleteMany(),
    prisma.supportRequest.deleteMany(),
    prisma.deliveryAttempt.deleteMany(),
    prisma.communication.deleteMany(),
    prisma.collectionStepExecution.deleteMany(),
    prisma.actionProposal.deleteMany(),
    prisma.operatorInsight.deleteMany(),
    prisma.businessEvent.deleteMany(),
    prisma.collectionSequence.deleteMany(),
    prisma.collectionPolicyStep.deleteMany(),
    prisma.collectionPolicy.deleteMany(),
    // Phase 13: wallet domain — walletTransaction/cryptoPaymentRequest must
    // be deleted before wallet/invoice/user (both hold RESTRICT foreign
    // keys into those tables) — see prisma/schema.prisma's Wallet Foundation
    // section.
    prisma.walletTransaction.deleteMany(),
    prisma.cryptoPaymentRequest.deleteMany(),
    prisma.wallet.deleteMany(),
    prisma.activityEvent.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.organizationMember.deleteMany(),
    prisma.organization.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}
