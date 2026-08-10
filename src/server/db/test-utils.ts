import { prisma } from "./client";

/**
 * Deletes all Phase 1 rows between tests. Deletion order follows foreign
 * keys explicitly rather than relying on cascade, so this keeps working if
 * a future model's cascade behavior changes.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.organizationMember.deleteMany(),
    prisma.organization.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}
