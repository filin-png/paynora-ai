-- CreateEnum
CREATE TYPE "CheckoutSessionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE 'CHECKOUT_SESSION_CREATED';

-- CreateTable
CREATE TABLE "billing_checkout_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "targetPlanId" "PlanId" NOT NULL,
    "status" "CheckoutSessionStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "externalPaymentId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkout_sessions_externalPaymentId_key" ON "billing_checkout_sessions"("externalPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkout_sessions_idempotencyKey_key" ON "billing_checkout_sessions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "billing_checkout_sessions_organizationId_createdAt_idx" ON "billing_checkout_sessions"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
