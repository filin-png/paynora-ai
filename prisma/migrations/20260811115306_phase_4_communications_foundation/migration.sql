-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "CommunicationPurpose" AS ENUM ('PAYMENT_REMINDER');

-- CreateEnum
CREATE TYPE "CommunicationStatus" AS ENUM ('DRAFT', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "DeliveryAttemptStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DeliveryFailureCategory" AS ENUM ('CONFIGURATION', 'VALIDATION', 'PROVIDER_REJECTED', 'TRANSIENT_PROVIDER_ERROR', 'TIMEOUT_OR_UNKNOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityEventType" ADD VALUE 'COMMUNICATION_PREPARED';
ALTER TYPE "ActivityEventType" ADD VALUE 'COMMUNICATION_EDITED';
ALTER TYPE "ActivityEventType" ADD VALUE 'COMMUNICATION_SEND_ATTEMPTED';
ALTER TYPE "ActivityEventType" ADD VALUE 'COMMUNICATION_SENT';
ALTER TYPE "ActivityEventType" ADD VALUE 'COMMUNICATION_SEND_FAILED';
ALTER TYPE "ActivityEventType" ADD VALUE 'ACTION_PROPOSAL_EXECUTED';

-- CreateTable
CREATE TABLE "communications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "actionProposalId" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL DEFAULT 'EMAIL',
    "purpose" "CommunicationPurpose" NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "CommunicationStatus" NOT NULL DEFAULT 'DRAFT',
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "aiProvider" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "DeliveryAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "failureCategory" "DeliveryFailureCategory",
    "failureMessage" TEXT,
    "providerMessageId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "communications_actionProposalId_key" ON "communications"("actionProposalId");

-- CreateIndex
CREATE INDEX "communications_organizationId_status_idx" ON "communications"("organizationId", "status");

-- CreateIndex
CREATE INDEX "communications_customerId_idx" ON "communications"("customerId");

-- CreateIndex
CREATE INDEX "communications_invoiceId_idx" ON "communications"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_idempotencyKey_key" ON "delivery_attempts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "delivery_attempts_organizationId_idx" ON "delivery_attempts"("organizationId");

-- CreateIndex
CREATE INDEX "delivery_attempts_communicationId_idx" ON "delivery_attempts"("communicationId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_communicationId_attemptNumber_key" ON "delivery_attempts"("communicationId", "attemptNumber");

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_actionProposalId_fkey" FOREIGN KEY ("actionProposalId") REFERENCES "action_proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_communicationId_fkey" FOREIGN KEY ("communicationId") REFERENCES "communications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
