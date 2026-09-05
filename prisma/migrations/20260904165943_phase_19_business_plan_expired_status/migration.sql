-- AlterEnum
ALTER TYPE "PlanId" ADD VALUE 'BUSINESS';

-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "organization_subscriptions" ADD COLUMN     "trialEndsAt" TIMESTAMP(3);
