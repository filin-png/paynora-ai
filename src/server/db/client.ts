import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { env } from "@/lib/env";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

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
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
