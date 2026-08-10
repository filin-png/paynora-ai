import { notFound, redirect } from "next/navigation";
import type { OrganizationRole } from "@prisma/client";

import { getSessionUser } from "@/server/auth/session";
import {
  requireOrganizationMembership,
  requireOrganizationRole,
  type OrganizationContext,
} from "./context";
import { OrganizationAccessDeniedError } from "./errors";
import type { SessionUser } from "./types";

/**
 * Next.js-specific translation layer over the pure primitives in
 * context.ts: turns "unauthenticated" into a redirect to sign-in, and
 * "no such org / not a member / wrong role" into a 404 (see
 * OrganizationAccessDeniedError for why those three collapse into one
 * outcome). Kept intentionally thin — anything with a decision to test
 * belongs in context.ts, not here.
 */
export async function requireUserForPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  return user;
}

export async function requireOrganizationMembershipForPage(
  organizationSlug: string,
): Promise<OrganizationContext> {
  const user = await requireUserForPage();
  try {
    return await requireOrganizationMembership(user, organizationSlug);
  } catch (error) {
    if (error instanceof OrganizationAccessDeniedError) notFound();
    throw error;
  }
}

export async function requireOrganizationRoleForPage(
  organizationSlug: string,
  role: OrganizationRole,
): Promise<OrganizationContext> {
  const user = await requireUserForPage();
  try {
    return await requireOrganizationRole(user, organizationSlug, role);
  } catch (error) {
    if (error instanceof OrganizationAccessDeniedError) notFound();
    throw error;
  }
}
