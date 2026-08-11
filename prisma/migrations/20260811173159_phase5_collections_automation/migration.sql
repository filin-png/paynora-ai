-- CreateEnum
CREATE TYPE "CollectionAutomationMode" AS ENUM ('APPROVAL_REQUIRED', 'AUTO_SEND');

-- CreateEnum
CREATE TYPE "CollectionStepAction" AS ENUM ('SEND_PAYMENT_REMINDER', 'NOTIFY_OWNER');

-- CreateEnum
CREATE TYPE "ReminderTone" AS ENUM ('SOFT', 'STANDARD', 'FIRM');

-- CreateEnum
CREATE TYPE "CollectionSequenceStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'STOPPED');

-- CreateEnum
CREATE TYPE "CollectionStopReason" AS ENUM ('PAID', 'CANCELLED', 'MANUAL', 'POLICY_DISABLED', 'AUTOMATION_DISABLED', 'CUSTOMER_ARCHIVED');

-- CreateEnum
CREATE TYPE "CollectionStepExecutionStatus" AS ENUM ('CLAIMED', 'EXECUTED', 'SKIPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityEventType" ADD VALUE 'COLLECTION_POLICY_CREATED';
ALTER TYPE "ActivityEventType" ADD VALUE 'COLLECTION_POLICY_UPDATED';
ALTER TYPE "ActivityEventType" ADD VALUE 'AUTOMATION_ENABLED';
ALTER TYPE "ActivityEventType" ADD VALUE 'AUTOMATION_DISABLED';
ALTER TYPE "ActivityEventType" ADD VALUE 'COLLECTION_SEQUENCE_STARTED';
ALTER TYPE "ActivityEventType" ADD VALUE 'COLLECTION_SEQUENCE_PAUSED';
ALTER TYPE "ActivityEventType" ADD VALUE 'COLLECTION_SEQUENCE_RESUMED';
ALTER TYPE "ActivityEventType" ADD VALUE 'COLLECTION_SEQUENCE_STOPPED';
ALTER TYPE "ActivityEventType" ADD VALUE 'COLLECTION_STEP_EXECUTED';
ALTER TYPE "ActivityEventType" ADD VALUE 'COLLECTION_STEP_SKIPPED';

-- AlterEnum
ALTER TYPE "BusinessEventType" ADD VALUE 'COLLECTION_STEP_DUE';

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "automationEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "collection_policies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "automationMode" "CollectionAutomationMode" NOT NULL DEFAULT 'APPROVAL_REQUIRED',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "autoSendEnabledByUserId" TEXT,
    "autoSendEnabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collection_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_policy_steps" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "daysAfterDue" INTEGER NOT NULL,
    "action" "CollectionStepAction" NOT NULL,
    "tone" "ReminderTone" NOT NULL DEFAULT 'STANDARD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_policy_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_sequences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "status" "CollectionSequenceStatus" NOT NULL DEFAULT 'ACTIVE',
    "stopReason" "CollectionStopReason",
    "pausedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collection_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_step_executions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "status" "CollectionStepExecutionStatus" NOT NULL DEFAULT 'CLAIMED',
    "businessEventId" TEXT,
    "actionProposalId" TEXT,
    "note" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "collection_step_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collection_policies_organizationId_idx" ON "collection_policies"("organizationId");

-- CreateIndex
CREATE INDEX "collection_policies_organizationId_isDefault_idx" ON "collection_policies"("organizationId", "isDefault");

-- CreateIndex
CREATE INDEX "collection_policy_steps_policyId_version_idx" ON "collection_policy_steps"("policyId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "collection_policy_steps_policyId_version_stepOrder_key" ON "collection_policy_steps"("policyId", "version", "stepOrder");

-- CreateIndex
CREATE UNIQUE INDEX "collection_policy_steps_policyId_version_daysAfterDue_key" ON "collection_policy_steps"("policyId", "version", "daysAfterDue");

-- CreateIndex
CREATE INDEX "collection_sequences_organizationId_status_idx" ON "collection_sequences"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "collection_sequences_organizationId_invoiceId_key" ON "collection_sequences"("organizationId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_step_executions_businessEventId_key" ON "collection_step_executions"("businessEventId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_step_executions_actionProposalId_key" ON "collection_step_executions"("actionProposalId");

-- CreateIndex
CREATE INDEX "collection_step_executions_organizationId_idx" ON "collection_step_executions"("organizationId");

-- CreateIndex
CREATE INDEX "collection_step_executions_sequenceId_idx" ON "collection_step_executions"("sequenceId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_step_executions_sequenceId_stepId_key" ON "collection_step_executions"("sequenceId", "stepId");

-- AddForeignKey
ALTER TABLE "collection_policies" ADD CONSTRAINT "collection_policies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_policies" ADD CONSTRAINT "collection_policies_autoSendEnabledByUserId_fkey" FOREIGN KEY ("autoSendEnabledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_policy_steps" ADD CONSTRAINT "collection_policy_steps_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "collection_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_sequences" ADD CONSTRAINT "collection_sequences_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_sequences" ADD CONSTRAINT "collection_sequences_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_sequences" ADD CONSTRAINT "collection_sequences_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_sequences" ADD CONSTRAINT "collection_sequences_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "collection_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_step_executions" ADD CONSTRAINT "collection_step_executions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_step_executions" ADD CONSTRAINT "collection_step_executions_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "collection_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_step_executions" ADD CONSTRAINT "collection_step_executions_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "collection_policy_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_step_executions" ADD CONSTRAINT "collection_step_executions_businessEventId_fkey" FOREIGN KEY ("businessEventId") REFERENCES "business_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_step_executions" ADD CONSTRAINT "collection_step_executions_actionProposalId_fkey" FOREIGN KEY ("actionProposalId") REFERENCES "action_proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CheckConstraint
-- Prisma's schema DSL has no portable way to declare these, so they're
-- hand-added here — a normal, supported migrate workflow (--create-only
-- then edit), same as the Phase 2 accounts-receivable-core migration.
ALTER TABLE "collection_policy_steps" ADD CONSTRAINT "collection_policy_steps_days_after_due_non_negative" CHECK ("daysAfterDue" >= 0);
ALTER TABLE "collection_policy_steps" ADD CONSTRAINT "collection_policy_steps_order_positive" CHECK ("stepOrder" > 0);
ALTER TABLE "collection_policies" ADD CONSTRAINT "collection_policies_version_positive" CHECK ("currentVersion" > 0);
ALTER TABLE "collection_sequences" ADD CONSTRAINT "collection_sequences_policy_version_positive" CHECK ("policyVersion" > 0);
