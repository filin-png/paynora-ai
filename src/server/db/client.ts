import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";

import { env } from "@/lib/env";

import { requireIsolatedTestDatabaseUrl } from "./test-database-target";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const isTestProcess = env.NODE_ENV === "test" || process.env.VITEST === "true";

/**
 * `max` bounds this one module instance's own connection pool. Under
 * either supported hosting model (DEPLOYMENT.md#production-hosting-model)
 * this module loads once — for the life of a long-lived process, or once
 * per serverless cold start, reused across warm invocations of that same
 * instance — so the right `DATABASE_POOL_MAX` value differs sharply
 * between them: a persistent process can use a larger pool (the default,
 * 10, node-postgres's own default), while a serverless deployment
 * (Vercel) should set this low (1-3), since *many* instances can be
 * running concurrently, each with its own pool against whatever
 * DATABASE_URL resolves to — see DEPLOYMENT.md#production-hosting-model
 * and docs/production-readiness.md#database for the full reasoning
 * (originally audited in docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md
 * P1-8).
 */
function createPrismaClient() {
  const connectionString = isTestProcess
    ? requireIsolatedTestDatabaseUrl(process.env.TEST_DATABASE_URL)
    : env.DATABASE_URL;
  const adapter = new PrismaPg({ connectionString, max: env.DATABASE_POOL_MAX });
  return new PrismaClient({ adapter });
}

export type PrismaWrite = <T>(write: (client: Prisma.TransactionClient) => Promise<T>) => Promise<T>;

export const prisma = (isTestProcess ? undefined : globalForPrisma.prisma) ?? createPrismaClient();

if (!isTestProcess && env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
