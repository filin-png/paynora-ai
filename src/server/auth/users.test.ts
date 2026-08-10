import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { EmailAlreadyRegisteredError, registerUser } from "./users";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("registerUser", () => {
  it("creates a user with a normalized email and a hashed password", async () => {
    const user = await registerUser({
      email: "  Owner@Example.com  ",
      password: "correct horse battery staple",
      name: "Owner",
    });

    expect(user.email).toBe("owner@example.com");

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).not.toBe("correct horse battery staple");
    expect(stored.passwordHash.length).toBeGreaterThan(20);
  });

  it("rejects a duplicate email (case-insensitive)", async () => {
    await registerUser({ email: "owner@example.com", password: "password123" });

    await expect(
      registerUser({ email: "Owner@Example.com", password: "another-password" }),
    ).rejects.toThrow(EmailAlreadyRegisteredError);
  });

  it("rejects an invalid email", async () => {
    await expect(
      registerUser({ email: "not-an-email", password: "password123" }),
    ).rejects.toThrow();
  });

  it("rejects a password shorter than 8 characters", async () => {
    await expect(
      registerUser({ email: "owner@example.com", password: "short" }),
    ).rejects.toThrow();
  });
});
