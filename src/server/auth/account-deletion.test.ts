import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createOrganization } from "@/server/tenancy/organizations";
import { verifyPassword } from "./password";
import { registerUser } from "./users";
import { anonymizeUserAccount, getAccountDeletionWarnings } from "./account-deletion";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

async function createTestUser(emailPrefix: string) {
  const email = `${emailPrefix}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  return registerUser({ email, password: "password123", name: "Test User" });
}

describe("anonymizeUserAccount", () => {
  it("overwrites email, name, and password so the account can never be found or signed into again", async () => {
    const user = await registerUser({ email: "victim@example.com", password: "original-password", name: "Victim" });

    await anonymizeUserAccount(user.id);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.email).not.toBe("victim@example.com");
    expect(updated.email).toContain("deleted");
    expect(updated.name).toBeNull();
    await expect(verifyPassword("original-password", updated.passwordHash)).resolves.toBe(false);
  });

  it("keeps the User row and every foreign key referencing it intact", async () => {
    const user = await createTestUser("owner");
    const organization = await createOrganization(user, "Acme");

    await anonymizeUserAccount(user.id);

    const stillExists = await prisma.user.findUnique({ where: { id: user.id } });
    expect(stillExists).not.toBeNull();
    const membership = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId: organization.id } },
    });
    expect(membership).not.toBeNull();
  });
});

describe("getAccountDeletionWarnings", () => {
  it("warns when the user is the sole OWNER of an organization", async () => {
    const user = await createTestUser("owner");
    const organization = await createOrganization(user, "Solo Org");

    const warnings = await getAccountDeletionWarnings(user.id);

    expect(warnings.soleOwnerOfOrganizations).toHaveLength(1);
    expect(warnings.soleOwnerOfOrganizations[0]?.id).toBe(organization.id);
  });

  it("does not warn when another OWNER exists in the organization", async () => {
    const user = await createTestUser("owner");
    const otherOwner = await createTestUser("other-owner");
    const organization = await createOrganization(user, "Shared Org");
    await prisma.organizationMember.create({
      data: { userId: otherOwner.id, organizationId: organization.id, role: "OWNER" },
    });

    const warnings = await getAccountDeletionWarnings(user.id);

    expect(warnings.soleOwnerOfOrganizations).toHaveLength(0);
  });

  it("does not warn about organizations where the user is a MEMBER, not an OWNER", async () => {
    const owner = await createTestUser("owner");
    const member = await createTestUser("member");
    const organization = await createOrganization(owner, "Member Org");
    await prisma.organizationMember.create({
      data: { userId: member.id, organizationId: organization.id, role: "MEMBER" },
    });

    const warnings = await getAccountDeletionWarnings(member.id);

    expect(warnings.soleOwnerOfOrganizations).toHaveLength(0);
  });

  it("returns no warnings for a user with no organizations", async () => {
    const user = await createTestUser("lonely");

    const warnings = await getAccountDeletionWarnings(user.id);

    expect(warnings.soleOwnerOfOrganizations).toHaveLength(0);
  });
});
