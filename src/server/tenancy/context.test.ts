import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { registerUser } from "@/server/auth/users";
import {
  requireOrganizationMembership,
  requireOrganizationRole,
  requireUser,
} from "./context";
import { createOrganization } from "./organizations";
import { OrganizationAccessDeniedError, UnauthenticatedError } from "./errors";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

async function createTestUser(emailPrefix: string) {
  const email = `${emailPrefix}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  return registerUser({ email, password: "password123" });
}

describe("requireUser", () => {
  it("returns the user when authenticated", () => {
    const user = { id: "u1", email: "u1@example.com", name: null };
    expect(requireUser(user)).toBe(user);
  });

  it("throws UnauthenticatedError when there is no session", () => {
    expect(() => requireUser(null)).toThrow(UnauthenticatedError);
  });
});

describe("requireOrganizationMembership — tenant isolation", () => {
  it("allows a member of Organization A to access Organization A", async () => {
    const owner = await createTestUser("owner");
    const orgA = await createOrganization(owner, "Org A");

    const context = await requireOrganizationMembership(owner, orgA.slug);

    expect(context.organization.id).toBe(orgA.id);
    expect(context.role).toBe("OWNER");
  });

  it("rejects a member of Organization A accessing Organization B", async () => {
    const ownerA = await createTestUser("owner-a");
    const ownerB = await createTestUser("owner-b");
    await createOrganization(ownerA, "Org A");
    const orgB = await createOrganization(ownerB, "Org B");

    await expect(requireOrganizationMembership(ownerA, orgB.slug)).rejects.toThrow(
      OrganizationAccessDeniedError,
    );
  });

  it("rejects unauthenticated access", async () => {
    const owner = await createTestUser("owner");
    const orgA = await createOrganization(owner, "Org A");

    await expect(requireOrganizationMembership(null, orgA.slug)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it("rejects access to a slug that doesn't exist, the same way as a real org you're not in", async () => {
    const owner = await createTestUser("owner");
    const otherOwner = await createTestUser("other-owner");
    const realOrg = await createOrganization(otherOwner, "Real Org");

    const nonexistentAttempt = requireOrganizationMembership(owner, "does-not-exist");
    const notAMemberAttempt = requireOrganizationMembership(owner, realOrg.slug);

    // Same error type for both — a slug enumeration attempt can't tell
    // "no such organization" from "exists, but you're not in it".
    await expect(nonexistentAttempt).rejects.toThrow(OrganizationAccessDeniedError);
    await expect(notAMemberAttempt).rejects.toThrow(OrganizationAccessDeniedError);
  });

  it("cannot be tricked by an organization id passed instead of its slug", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Org A");

    // requireOrganizationMembership looks up by slug; passing the raw id
    // must not accidentally match anything.
    await expect(requireOrganizationMembership(owner, org.id)).rejects.toThrow(
      OrganizationAccessDeniedError,
    );
  });
});

describe("requireOrganizationRole — OWNER vs MEMBER authorization", () => {
  it("allows OWNER to perform an OWNER-only operation", async () => {
    const owner = await createTestUser("owner");
    const org = await createOrganization(owner, "Org A");

    await expect(requireOrganizationRole(owner, org.slug, "OWNER")).resolves.toMatchObject({
      role: "OWNER",
    });
  });

  it("rejects MEMBER performing an OWNER-only operation", async () => {
    const owner = await createTestUser("owner");
    const member = await createTestUser("member");
    const org = await createOrganization(owner, "Org A");
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: member.id, role: "MEMBER" },
    });

    await expect(requireOrganizationRole(member, org.slug, "OWNER")).rejects.toThrow(
      OrganizationAccessDeniedError,
    );
  });
});
