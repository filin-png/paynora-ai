import { prisma } from "@/server/db/client";

export type UserDataExport = {
  exportedAt: string;
  account: { id: string; email: string; name: string | null; createdAt: string };
  organizationMemberships: { organizationId: string; organizationName: string; role: string; joinedAt: string }[];
};

/**
 * A real, minimal "export my data" mechanism (Phase 15A, Settings ->
 * Privacy) — see docs/privacy-policy.md#16-user-rights for why this is
 * deliberately scoped to the requesting user's own account data, never
 * an organization's financial records: `Customer`/`Invoice`/`Payment`
 * belong to the organization, not to any one member, so one member
 * exporting them unilaterally would itself be a privacy/authorization
 * problem — that data is already visible to every member through the
 * product's own Invoices/Customers pages, scoped by the same tenant
 * isolation every other read in this codebase uses.
 */
export async function exportUserData(userId: string): Promise<UserDataExport> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true, createdAt: true },
  });

  const memberships = await prisma.organizationMember.findMany({
    where: { userId },
    include: { organization: { select: { name: true } } },
  });

  return {
    exportedAt: new Date().toISOString(),
    account: {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    },
    organizationMemberships: memberships.map((membership) => ({
      organizationId: membership.organizationId,
      organizationName: membership.organization.name,
      role: membership.role,
      joinedAt: membership.createdAt.toISOString(),
    })),
  };
}
