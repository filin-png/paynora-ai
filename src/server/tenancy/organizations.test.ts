import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { registerUser } from "@/server/auth/users";
import {
  createOrganization,
  listOrganizationMembers,
  listUserOrganizations,
  setOrganizationAnalyticsEnabled,
  updateOrganizationName,
} from "./organizations";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

async function createTestUser(emailPrefix: string) {
  const email = `${emailPrefix}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const user = await registerUser({ email, password: "password123" });
  return user;
}

describe("createOrganization", () => {
  it("creates the organization and makes the creator its OWNER", async () => {
    const user = await createTestUser("owner");

    const organization = await createOrganization(user, "Acme Agency");

    expect(organization.role).toBe("OWNER");

    const membership = await prisma.organizationMember.findUniqueOrThrow({
      where: { userId_organizationId: { userId: user.id, organizationId: organization.id } },
    });
    expect(membership.role).toBe("OWNER");
  });

  it("does not leave an orphan organization when membership creation fails", async () => {
    // A user id that doesn't exist makes the OrganizationMember insert's
    // foreign key fail after the Organization insert has already run
    // inside the same transaction — this is the real failure mode the
    // "no orphan organization" acceptance criterion is about.
    const ghostUser = { id: "nonexistent-user-id", email: "ghost@example.com", name: null };

    await expect(createOrganization(ghostUser, "Ghost Org")).rejects.toThrow();

    const persisted = await prisma.organization.findUnique({ where: { slug: "ghost-org" } });
    expect(persisted).toBeNull();
  });

  it("de-duplicates slugs for organizations with the same name", async () => {
    const userA = await createTestUser("a");
    const userB = await createTestUser("b");

    const orgA = await createOrganization(userA, "Acme");
    const orgB = await createOrganization(userB, "Acme");

    expect(orgA.slug).not.toBe(orgB.slug);
  });
});

describe("listUserOrganizations", () => {
  it("only returns organizations the user is a member of", async () => {
    const userA = await createTestUser("a");
    const userB = await createTestUser("b");

    const orgA = await createOrganization(userA, "Org A");
    await createOrganization(userB, "Org B");

    const result = await listUserOrganizations(userA);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(orgA.id);
  });
});

describe("updateOrganizationName", () => {
  it("updates the organization's name", async () => {
    const user = await createTestUser("owner");
    const organization = await createOrganization(user, "Old Name");

    await updateOrganizationName(organization.id, "New Name");

    const updated = await prisma.organization.findUniqueOrThrow({
      where: { id: organization.id },
    });
    expect(updated.name).toBe("New Name");
  });
});

describe("setOrganizationAnalyticsEnabled", () => {
  it("persists the opt-out and is reflected by a real read", async () => {
    const user = await createTestUser("owner");
    const organization = await createOrganization(user, "Analytics Test Org");
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } })).analyticsEnabled).toBe(
      true,
    );

    await setOrganizationAnalyticsEnabled(organization.id, false);

    const updated = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(updated.analyticsEnabled).toBe(false);
  });

  it("can be turned back on", async () => {
    const user = await createTestUser("owner");
    const organization = await createOrganization(user, "Analytics Test Org 2");
    await setOrganizationAnalyticsEnabled(organization.id, false);

    await setOrganizationAnalyticsEnabled(organization.id, true);

    const updated = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(updated.analyticsEnabled).toBe(true);
  });
});

describe("listOrganizationMembers", () => {
  it("lists members with their roles", async () => {
    const owner = await createTestUser("owner");
    const member = await createTestUser("member");
    const organization = await createOrganization(owner, "Acme");
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, userId: member.id, role: "MEMBER" },
    });

    const members = await listOrganizationMembers(organization.id);

    expect(members).toHaveLength(2);
    expect(members.find((m) => m.userId === owner.id)?.role).toBe("OWNER");
    expect(members.find((m) => m.userId === member.id)?.role).toBe("MEMBER");
  });
});

describe("duplicate membership prevention", () => {
  it("rejects a second membership row for the same user and organization", async () => {
    const user = await createTestUser("owner");
    const organization = await createOrganization(user, "Acme");

    await expect(
      prisma.organizationMember.create({
        data: { organizationId: organization.id, userId: user.id, role: "MEMBER" },
      }),
    ).rejects.toThrow();
  });
});
