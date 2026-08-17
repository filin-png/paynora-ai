import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import type { EmailMessage, EmailProvider } from "@/server/email/types";
import { verifyPassword } from "./password";
import {
  InvalidOrExpiredResetTokenError,
  requestPasswordReset,
  resetPassword,
} from "./password-reset";
import { registerUser } from "./users";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const ORIGINAL_PASSWORD = "correct horse battery staple";

function createCapturingEmailProvider() {
  const messages: EmailMessage[] = [];
  const provider: EmailProvider = {
    name: "capturing-fake",
    async send(message) {
      messages.push(message);
      return { provider: "capturing-fake" };
    },
  };
  return { provider, messages };
}

function extractToken(text: string): string {
  const match = text.match(/token=([^&\s]+)/);
  if (!match) throw new Error("no token found in email body");
  return match[1];
}

async function setupUser(email = "owner@example.com") {
  return registerUser({ email, password: ORIGINAL_PASSWORD, name: "Owner" });
}

describe("requestPasswordReset", () => {
  it("a known email issues a token and emails a reset link", async () => {
    const user = await setupUser();
    const { provider, messages } = createCapturingEmailProvider();

    const outcome = await requestPasswordReset(user.email, "1.1.1.1", { provider });

    expect(outcome).toBe("requested");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe(user.email);

    const stored = await prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(stored).not.toBeNull();
  });

  it("an unknown email returns the exact same public outcome, with no email sent", async () => {
    const { provider, messages } = createCapturingEmailProvider();

    const outcome = await requestPasswordReset("nobody@example.com", "1.1.1.1", { provider });

    expect(outcome).toBe("requested");
    expect(messages).toHaveLength(0);
  });

  it("never persists the raw token — only its digest", async () => {
    const user = await setupUser();
    const { provider, messages } = createCapturingEmailProvider();

    await requestPasswordReset(user.email, "2.2.2.2", { provider });
    const rawToken = extractToken(messages[0]!.text);

    const stored = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(stored.tokenHash).toHaveLength(64); // hex-encoded SHA-256
  });

  it("a newer request supersedes the older still-usable token", async () => {
    const user = await setupUser();
    const first = createCapturingEmailProvider();
    await requestPasswordReset(user.email, "3.3.3.1", { provider: first.provider });
    const firstToken = extractToken(first.messages[0]!.text);

    const second = createCapturingEmailProvider();
    await requestPasswordReset(user.email, "3.3.3.2", { provider: second.provider });
    const secondToken = extractToken(second.messages[0]!.text);

    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1); // the old one was deleted, not left dangling

    await expect(resetPassword(firstToken, "new-password-123")).rejects.toThrow(
      InvalidOrExpiredResetTokenError,
    );
    await expect(resetPassword(secondToken, "new-password-123")).resolves.toBeUndefined();
  });

  it("blocks further requests once the per-account threshold is exceeded", async () => {
    const user = await setupUser();
    const { provider } = createCapturingEmailProvider();

    // PASSWORD_RESET_REQUEST_ACCOUNT_POLICY.maxAttempts is 5.
    for (let i = 0; i < 5; i++) {
      await requestPasswordReset(user.email, `10.0.1.${i}`, { provider });
    }
    const blocked = await requestPasswordReset(user.email, "10.0.1.99", { provider });
    expect(blocked).toBe("rate_limited");
  }, 20000);

  it("blocks further requests once the per-IP threshold is exceeded, regardless of target email", async () => {
    const userA = await setupUser("a@example.com");
    const userB = await registerUser({ email: "b@example.com", password: ORIGINAL_PASSWORD });
    const { provider } = createCapturingEmailProvider();
    const sharedIp = "203.0.113.9";

    // PASSWORD_RESET_REQUEST_IP_POLICY.maxAttempts is 10.
    for (let i = 0; i < 10; i++) {
      await requestPasswordReset(userA.email, sharedIp, { provider });
    }
    const blocked = await requestPasswordReset(userB.email, sharedIp, { provider });
    expect(blocked).toBe("rate_limited");
  }, 20000);
});

describe("resetPassword", () => {
  async function issueToken(email: string) {
    const { provider, messages } = createCapturingEmailProvider();
    await requestPasswordReset(email, "9.9.9.9", { provider });
    return extractToken(messages[0]!.text);
  }

  it("a valid token sets a new password", async () => {
    const user = await setupUser();
    const token = await issueToken(user.email);

    await resetPassword(token, "brand-new-password-1");

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    await expect(verifyPassword("brand-new-password-1", updated.passwordHash)).resolves.toBe(true);
  });

  it("the old password no longer works after a reset", async () => {
    const user = await setupUser();
    const token = await issueToken(user.email);

    await resetPassword(token, "brand-new-password-2");

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    await expect(verifyPassword(ORIGINAL_PASSWORD, updated.passwordHash)).resolves.toBe(false);
  });

  it("rejects an unknown token", async () => {
    await expect(resetPassword("not-a-real-token", "brand-new-password-3")).rejects.toThrow(
      InvalidOrExpiredResetTokenError,
    );
  });

  it("rejects an expired token", async () => {
    const user = await setupUser();
    const token = await issueToken(user.email);

    const future = new Date(Date.now() + 2 * 60 * 60 * 1000); // well past the 1-hour TTL
    await expect(resetPassword(token, "brand-new-password-4", future)).rejects.toThrow(
      InvalidOrExpiredResetTokenError,
    );
  });

  it("rejects a token that has already been used (single-use)", async () => {
    const user = await setupUser();
    const token = await issueToken(user.email);

    await resetPassword(token, "brand-new-password-5");
    await expect(resetPassword(token, "another-password-6")).rejects.toThrow(
      InvalidOrExpiredResetTokenError,
    );
  });

  it("a token issued for one user can never reset a different user's password", async () => {
    const victim = await setupUser("victim@example.com");
    const attacker = await registerUser({ email: "attacker@example.com", password: ORIGINAL_PASSWORD });
    const attackerToken = await issueToken(attacker.email);

    await resetPassword(attackerToken, "attacker-new-password-7");

    const victimAfter = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    await expect(verifyPassword(ORIGINAL_PASSWORD, victimAfter.passwordHash)).resolves.toBe(true);
  });

  it("rejects a password shorter than the project minimum", async () => {
    const user = await setupUser();
    const token = await issueToken(user.email);

    await expect(resetPassword(token, "short")).rejects.toThrow();
  });

  it("concurrent reset attempts with the same token: only one can win", async () => {
    const user = await setupUser();
    const token = await issueToken(user.email);

    const results = await Promise.allSettled([
      resetPassword(token, "password-race-a"),
      resetPassword(token, "password-race-b"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const aWon = await verifyPassword("password-race-a", updated.passwordHash);
    const bWon = await verifyPassword("password-race-b", updated.passwordHash);
    expect(aWon !== bWon).toBe(true); // exactly one of the two took effect
  });
});
