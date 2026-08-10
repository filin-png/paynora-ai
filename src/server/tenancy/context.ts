import type { OrganizationRole } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { OrganizationAccessDeniedError, UnauthenticatedError } from "./errors";
import type { SessionUser } from "./types";

export type OrganizationContext = {
  user: SessionUser;
  organization: { id: string; name: string; slug: string };
  role: OrganizationRole;
};

/**
 * Framework-agnostic authorization primitives. They take an already-resolved
 * `SessionUser | null` rather than reading cookies/headers themselves, so
 * they run unmodified in a Vitest test against a real database and in a
 * Next.js request — the only thing that differs is who calls them and what
 * they do with a thrown error. See src/server/tenancy/guards.ts for the
 * Next.js-specific translation (redirect/notFound) used by pages, and
 * docs/identity-and-tenancy.md for the full design rationale.
 */
export function requireUser(user: SessionUser | null): SessionUser {
  if (!user) throw new UnauthenticatedError();
  return user;
}

export async function requireOrganizationMembership(
  user: SessionUser | null,
  organizationSlug: string,
): Promise<OrganizationContext> {
  const authenticatedUser = requireUser(user);

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
    select: { id: true, name: true, slug: true },
  });
  if (!organization) throw new OrganizationAccessDeniedError();

  const membership = await prisma.organizationMember.findUnique({
    where: {
      userId_organizationId: {
        userId: authenticatedUser.id,
        organizationId: organization.id,
      },
    },
    select: { role: true },
  });
  if (!membership) throw new OrganizationAccessDeniedError();

  return { user: authenticatedUser, organization, role: membership.role };
}

export async function requireOrganizationRole(
  user: SessionUser | null,
  organizationSlug: string,
  role: OrganizationRole,
): Promise<OrganizationContext> {
  const context = await requireOrganizationMembership(user, organizationSlug);
  if (context.role !== role) throw new OrganizationAccessDeniedError();
  return context;
}
