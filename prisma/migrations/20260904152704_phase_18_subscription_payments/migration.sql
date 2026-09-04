-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE 'SUBSCRIPTION_STATUS_CHANGED';

-- CreateTable
CREATE TABLE "subscription_payments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "amountMinor" BIGINT,
    "currency" TEXT,
    "status" "SubscriptionStatus" NOT NULL,
    "planIdRaw" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscription_payments_organizationId_receivedAt_idx" ON "subscription_payments"("organizationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_provider_externalEventId_key" ON "subscription_payments"("provider", "externalEventId");

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
