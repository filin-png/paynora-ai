-- CreateEnum
CREATE TYPE "PlanId" AS ENUM ('FREE', 'STARTER', 'PRO');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED');

-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE 'PLAN_CHANGED';

-- CreateTable
CREATE TABLE "organization_subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "plan" "PlanId" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "billingProvider" TEXT,
    "externalCustomerId" TEXT,
    "externalSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_subscriptions_organizationId_key" ON "organization_subscriptions"("organizationId");

-- AddForeignKey
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (Section 15, "Migration / Backward Compatibility"): every
-- organization that existed before this migration must deterministically
-- land on FREE/ACTIVE — the same default a brand-new organization gets
-- (see createOrganization in src/server/tenancy/organizations.ts) — rather
-- than being left with no subscription row, which the entitlement layer
-- would otherwise have to treat as an undefined/null special case. IDs are
-- generated here (not via a DB-level default — this schema's `@default(cuid())`
-- is an application-layer default, not a Postgres one, same as every other
-- model in this codebase) using md5(random()) purely for uniqueness; the
-- format need not match a real cuid, since nothing ever parses this column
-- as one.
INSERT INTO "organization_subscriptions" ("id", "organizationId", "plan", "status", "createdAt", "updatedAt")
SELECT
  'sub_' || substr(md5(random()::text || clock_timestamp()::text || o."id"), 1, 20),
  o."id",
  'FREE',
  'ACTIVE',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "organizations" o
WHERE NOT EXISTS (
  SELECT 1 FROM "organization_subscriptions" os WHERE os."organizationId" = o."id"
);
