import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { env } from "@/lib/env";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * `max` bounds this process's own connection pool — meaningful because
 * PAYNORA's supported production model is a long-lived Node.js process
 * (one pool for the process's lifetime), not a per-invocation serverless
 * function (where a pool size setting is close to meaningless — see
 * DEPLOYMENT.md#production-hosting-model for the full reasoning and
 * docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-8 for the audit finding
 * this closes). `DATABASE_POOL_MAX` defaults to 10 (node-postgres's own
 * default), env-configurable per deployment size.
 */
function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
