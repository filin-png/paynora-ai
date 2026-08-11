-- CreateEnum
CREATE TYPE "BusinessEventType" AS ENUM ('INVOICE_OVERDUE');

-- CreateEnum
CREATE TYPE "InsightPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('SEND_PAYMENT_REMINDER');

-- CreateEnum
CREATE TYPE "ActionProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'DISMISSED', 'EXECUTED', 'FAILED');

-- CreateTable
CREATE TABLE "business_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "BusinessEventType" NOT NULL,
    "customerId" TEXT,
    "invoiceId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_insights" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "businessEventId" TEXT NOT NULL,
    "customerId" TEXT,
    "invoiceId" TEXT,
    "priority" "InsightPriority" NOT NULL,
    "summary" TEXT NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "aiProvider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_proposals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "insightId" TEXT NOT NULL,
    "customerId" TEXT,
    "invoiceId" TEXT,
    "type" "ActionType" NOT NULL,
    "status" "ActionProposalStatus" NOT NULL DEFAULT 'PENDING',
    "reasoning" TEXT NOT NULL,
    "suggestedTone" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "business_events_organizationId_type_idx" ON "business_events"("organizationId", "type");

-- CreateIndex
CREATE INDEX "business_events_invoiceId_idx" ON "business_events"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "business_events_organizationId_type_dedupeKey_key" ON "business_events"("organizationId", "type", "dedupeKey");

-- CreateIndex
CREATE INDEX "operator_insights_organizationId_priority_idx" ON "operator_insights"("organizationId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "operator_insights_organizationId_businessEventId_key" ON "operator_insights"("organizationId", "businessEventId");

-- CreateIndex
CREATE INDEX "action_proposals_organizationId_status_idx" ON "action_proposals"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "action_proposals_organizationId_insightId_type_key" ON "action_proposals"("organizationId", "insightId", "type");

-- AddForeignKey
ALTER TABLE "business_events" ADD CONSTRAINT "business_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_events" ADD CONSTRAINT "business_events_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_events" ADD CONSTRAINT "business_events_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_insights" ADD CONSTRAINT "operator_insights_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_insights" ADD CONSTRAINT "operator_insights_businessEventId_fkey" FOREIGN KEY ("businessEventId") REFERENCES "business_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_insights" ADD CONSTRAINT "operator_insights_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_insights" ADD CONSTRAINT "operator_insights_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "operator_insights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
