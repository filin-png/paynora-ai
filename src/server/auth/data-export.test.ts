import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createOrganization } from "@/server/tenancy/organizations";
import { registerUser } from "./users";
import { exportUserData } from "./data-export";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

async function createTestUser(emailPrefix: string) {
  const email = `${emailPrefix}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  return registerUser({ email, password: "password123", name: "Test User" });
}

describe("exportUserData", () => {
  it("includes the account's own identity fields", async () => {
    const user = await registerUser({ email: "owner@example.com", password: "password123", name: "Owner Name" });

    const result = await exportUserData(user.id);

    expect(result.account.id).toBe(user.id);
    expect(result.account.email).toBe("owner@example.com");
    expect(result.account.name).toBe("Owner Name");
  });

  it("lists every organization the user is a member of, with role", async () => {
    const user = await createTestUser("member");
    const organization = await createOrganization(user, "Acme");

    const result = await exportUserData(user.id);

    expect(result.organizationMemberships).toHaveLength(1);
    expect(result.organizationMemberships[0]?.organizationId).toBe(organization.id);
    expect(result.organizationMemberships[0]?.role).toBe("OWNER");
  });

  it("does not include another user's organization memberships", async () => {
    const userA = await createTestUser("a");
    const userB = await createTestUser("b");
    await createOrganization(userA, "Org A");
    await createOrganization(userB, "Org B");

    const result = await exportUserData(userA.id);

    expect(result.organizationMemberships).toHaveLength(1);
  });

  it("never includes the password hash or organization-owned financial data", async () => {
    const user = await createTestUser("owner");
    await createOrganization(user, "Acme");

    const result = await exportUserData(user.id);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("passwordHash");
    expect(result).not.toHaveProperty("customers");
    expect(result).not.toHaveProperty("invoices");
    expect(result).not.toHaveProperty("payments");
  });
});
