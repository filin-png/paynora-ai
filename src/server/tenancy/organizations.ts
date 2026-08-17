import { z } from "zod";

import { prisma } from "@/server/db/client";
import { generateUniqueOrganizationSlug } from "./slug";
import type { SessionUser } from "./types";

export const organizationNameSchema = z
  .string()
  .trim()
  .min(2, "Organization name must be at least 2 characters")
  .max(100, "Organization name must be at most 100 characters");

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  role: "OWNER" | "MEMBER";
};

/**
 * Creates an organization and its creator's OWNER membership atomically.
 * If the membership insert fails for any reason, Prisma's interactive
 * transaction rolls back the organization insert too — no orphan
 * organization can be left behind (Phase 1 acceptance criterion).
 */
export async function createOrganization(
  user: SessionUser,
  rawName: string,
): Promise<OrganizationSummary> {
  const name = organizationNameSchema.parse(rawName);
  const slug = await generateUniqueOrganizationSlug(name, async (candidate) => {
    const existing = await prisma.organization.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    return existing !== null;
  });

  const organization = await prisma.$transaction(async (tx) => {
    const created = await tx.organization.create({
      data: { name, slug },
    });
    await tx.organizationMember.create({
      data: {
        organizationId: created.id,
        userId: user.id,
        role: "OWNER",
      },
    });
    // Every organization has exactly one subscription row from the moment
    // it exists — FREE/ACTIVE, the same default an existing pre-Phase-11.3
    // organization was backfilled to (see that migration's doc comment).
    // Created here, transactionally, so "an organization with no
    // subscription row" is never a state the entitlement layer needs to
    // handle — see src/server/billing/entitlements.ts.
    await tx.organizationSubscription.create({
      data: { organizationId: created.id, plan: "FREE", status: "ACTIVE" },
    });
    return created;
  });

  return { id: organization.id, name: organization.name, slug: organization.slug, role: "OWNER" };
}

export async function listUserOrganizations(
  user: SessionUser,
): Promise<OrganizationSummary[]> {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId: user.id },
    include: { organization: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "asc" },
  });

  return memberships.map((membership) => ({
    id: membership.organization.id,
    name: membership.organization.name,
    slug: membership.organization.slug,
    role: membership.role,
  }));
}

export async function updateOrganizationName(
  organizationId: string,
  rawName: string,
): Promise<void> {
  const name = organizationNameSchema.parse(rawName);
  await prisma.organization.update({
    where: { id: organizationId },
    data: { name },
  });
}

export async function listOrganizationMembers(organizationId: string) {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });

  return members.map((member) => ({
    userId: member.user.id,
    email: member.user.email,
    name: member.user.name,
    role: member.role,
  }));
}
