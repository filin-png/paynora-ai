import { prisma } from "./client";

/**
 * Deletes all rows between tests. Deletion order follows foreign keys
 * explicitly rather than relying on cascade, so this keeps working if a
 * future model's cascade behavior changes (several Phase 2 relations are
 * intentionally RESTRICT, not CASCADE — see docs/accounts-receivable.md).
 */
export async function resetDatabase(): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Database reset requires NODE_ENV=test");
  }

  await prisma.$transaction(async (tx) => {
    const [identity] = await tx.$queryRaw<{ ok: boolean | null }[]>`
      SELECT pg_catalog.current_database() = 'paynora_test'
         AND session_user = 'paynora_test_runner'
         AND current_user = 'paynora_test_runner'
         AND pg_catalog.inet_server_addr() = '127.0.0.1'::inet
         AND pg_catalog.inet_server_port() = 55432
         AND pg_catalog.current_schema() = 'public'
         AND pg_catalog.current_setting('cluster_name', true) = 'paynora_test_isolated'
         AS ok
    `;
    if (identity?.ok !== true) {
      throw new Error("Refusing to reset a database outside the isolated PAYNORA test cluster");
    }

    await tx.rateLimitCounter.deleteMany();
    await tx.automationTickRun.deleteMany();
    await tx.passwordResetToken.deleteMany();
    await tx.organizationInvitation.deleteMany();
    await tx.billingCheckoutSession.deleteMany();
    await tx.subscriptionPayment.deleteMany();
    await tx.organizationSubscription.deleteMany();
    await tx.supportRequest.deleteMany();
    // Stage 4A history follows the organization cascade below. Its links to
    // delivery attempts are deferred until commit, so the existing ordered
    // fixture cleanup can still respect the older immediate RESTRICT FKs.
    await tx.deliveryAttempt.deleteMany();
    await tx.communication.deleteMany();
    await tx.collectionStepExecution.deleteMany();
    await tx.actionProposal.deleteMany();
    await tx.operatorInsight.deleteMany();
    await tx.businessEvent.deleteMany();
    await tx.collectionSequence.deleteMany();
    await tx.collectionPolicyStep.deleteMany();
    await tx.collectionPolicy.deleteMany();
    // Phase 13: wallet domain — walletTransaction/cryptoPaymentRequest must
    // be deleted before wallet/invoice/user (both hold RESTRICT foreign
    // keys into those tables) — see prisma/schema.prisma's Wallet Foundation
    // section.
    await tx.walletTransaction.deleteMany();
    await tx.cryptoPaymentRequest.deleteMany();
    await tx.wallet.deleteMany();
    await tx.activityEvent.deleteMany();
    await tx.payment.deleteMany();
    await tx.invoice.deleteMany();
    await tx.customer.deleteMany();
    await tx.organizationMember.deleteMany();
    await tx.organization.deleteMany();
    await tx.user.deleteMany();
  });
}
