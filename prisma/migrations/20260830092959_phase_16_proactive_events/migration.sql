-- AlterEnum
ALTER TYPE "ActionProposalStatus" ADD VALUE 'STALE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BusinessEventType" ADD VALUE 'PAYMENT_RECEIVED';
ALTER TYPE "BusinessEventType" ADD VALUE 'INVOICE_RISK_ESCALATED';
ALTER TYPE "BusinessEventType" ADD VALUE 'CUSTOMER_PAYMENT_BEHAVIOR_DETERIORATED';
