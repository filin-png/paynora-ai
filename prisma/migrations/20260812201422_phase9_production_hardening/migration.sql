-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "automationLastTickAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateTable
CREATE TABLE "rate_limit_counters" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_tick_runs" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "globallyDisabled" BOOLEAN NOT NULL DEFAULT false,
    "organizationsProcessed" INTEGER NOT NULL DEFAULT 0,
    "organizationsRemaining" INTEGER NOT NULL DEFAULT 0,
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "enrolled" INTEGER NOT NULL DEFAULT 0,
    "claimed" INTEGER NOT NULL DEFAULT 0,
    "executed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "stopped" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "crashed" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,

    CONSTRAINT "automation_tick_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_limit_counters_scope_key_idx" ON "rate_limit_counters"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_counters_scope_key_windowStart_key" ON "rate_limit_counters"("scope", "key", "windowStart");

-- CreateIndex
CREATE INDEX "automation_tick_runs_startedAt_idx" ON "automation_tick_runs"("startedAt");

-- CreateIndex
CREATE INDEX "invoices_organizationId_issueDate_idx" ON "invoices"("organizationId", "issueDate");

-- CreateIndex
CREATE INDEX "payments_organizationId_createdAt_idx" ON "payments"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_invoiceId_idempotencyKey_key" ON "payments"("invoiceId", "idempotencyKey");

-- Hand-added, not representable in schema.prisma (Prisma has no partial/
-- filtered unique index syntax for PostgreSQL as of this version) — the
-- same pattern already used for Phase 2/5's hand-added CHECK constraints.
-- Backs setDefaultCollectionPolicy's "at most one default policy per
-- organization" invariant at the database level, not just via the
-- application's unset-then-set transaction — see
-- src/server/collections/policy.ts and
-- docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P2-3.
CREATE UNIQUE INDEX "collection_policies_one_default_per_org"
  ON "collection_policies" ("organizationId")
  WHERE "isDefault" = true;

