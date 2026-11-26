import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { AI_GENERATION_QUOTA_SCOPE, BILLING_USAGE_WINDOW_MS, COPILOT_USAGE_SCOPE } from "./policies";
import { checkRateLimit, resetRateLimit } from "./service";

beforeEach(async () => {
  await resetDatabase();
});

const policy = { maxAttempts: 5, windowMs: 60_000 };

describe("checkRateLimit", () => {
  it("allows attempts up to the limit, then blocks", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 1; i <= 5; i++) {
      const result = await checkRateLimit("test", "key-a", policy, now);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5 - i);
    }
    const sixth = await checkRateLimit("test", "key-a", policy, now);
    expect(sixth.allowed).toBe(false);
    expect(sixth.remaining).toBe(0);
  });

  it("normal attempts (well under the threshold) are never blocked", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const r1 = await checkRateLimit("test", "key-normal", policy, now);
    const r2 = await checkRateLimit("test", "key-normal", policy, now);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
  });

  it("resets once the window elapses", async () => {
    const windowed = { maxAttempts: 2, windowMs: 1000 };
    const firstWindow = new Date("2026-01-01T00:00:00.000Z");
    await checkRateLimit("test", "key-window", windowed, firstWindow);
    await checkRateLimit("test", "key-window", windowed, firstWindow);
    const stillBlocked = await checkRateLimit("test", "key-window", windowed, firstWindow);
    expect(stillBlocked.allowed).toBe(false);

    const nextWindow = new Date(firstWindow.getTime() + windowed.windowMs);
    const afterReset = await checkRateLimit("test", "key-window", windowed, nextWindow);
    expect(afterReset.allowed).toBe(true);
  });

  it("different keys within the same scope never share a budget", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 5; i++) await checkRateLimit("test", "key-b", policy, now);
    const blocked = await checkRateLimit("test", "key-b", policy, now);
    expect(blocked.allowed).toBe(false);

    // A totally different key (e.g. a different account/tenant) is
    // unaffected — no shared budget.
    const otherKey = await checkRateLimit("test", "key-c", policy, now);
    expect(otherKey.allowed).toBe(true);
  });

  it("different scopes for the same key never share a budget", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 5; i++) await checkRateLimit("scope-a", "shared-key", policy, now);
    const blockedInScopeA = await checkRateLimit("scope-a", "shared-key", policy, now);
    expect(blockedInScopeA.allowed).toBe(false);

    const scopeB = await checkRateLimit("scope-b", "shared-key", policy, now);
    expect(scopeB.allowed).toBe(true);
  });

  it("concurrent parallel attempts cannot trivially bypass the limit (real Postgres atomicity)", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkRateLimit("test", "key-concurrent", policy, now)),
    );
    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(5); // exactly maxAttempts, never more, despite 20 parallel callers
  });
});

describe("resetRateLimit", () => {
  it("clears the current window's count, freeing up the full budget again", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 5; i++) await checkRateLimit("test", "key-reset", policy, now);
    const blocked = await checkRateLimit("test", "key-reset", policy, now);
    expect(blocked.allowed).toBe(false);

    await resetRateLimit("test", "key-reset", policy, now);

    const afterReset = await checkRateLimit("test", "key-reset", policy, now);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(4);
  });

  it("is a safe no-op when no counter exists yet for the current window", async () => {
    await expect(resetRateLimit("test", "key-never-used", policy)).resolves.not.toThrow();
  });
});

describe("data hygiene", () => {
  it("cleans expired counters without reopening active billing windows", async () => {
    const now = new Date("2026-11-26T17:03:07.000Z");
    const billingWindowStart = new Date(Math.floor(now.getTime() / BILLING_USAGE_WINDOW_MS) * BILLING_USAGE_WINDOW_MS);
    const expiredBillingWindowStart = new Date(billingWindowStart.getTime() - BILLING_USAGE_WINDOW_MS);
    const expiredRequestWindowStart = new Date("2026-11-24T00:00:00.000Z");
    const key = "billing-org";

    await prisma.rateLimitCounter.createMany({
      data: [
        { scope: AI_GENERATION_QUOTA_SCOPE, key, windowStart: billingWindowStart, count: 20 },
        { scope: COPILOT_USAGE_SCOPE, key, windowStart: billingWindowStart, count: 7 },
        { scope: AI_GENERATION_QUOTA_SCOPE, key, windowStart: expiredBillingWindowStart, count: 20 },
        { scope: COPILOT_USAGE_SCOPE, key, windowStart: expiredBillingWindowStart, count: 7 },
        { scope: "test", key: "expired-request", windowStart: expiredRequestWindowStart, count: 1 },
      ],
    });

    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await checkRateLimit("test", "active-request", policy, now);
      const quota = await checkRateLimit(
        AI_GENERATION_QUOTA_SCOPE,
        key,
        { maxAttempts: 20, windowMs: BILLING_USAGE_WINDOW_MS },
        now,
      );

      expect(quota.allowed).toBe(false);
      expect(await prisma.rateLimitCounter.findMany({
        where: { key },
        orderBy: { scope: "asc" },
        select: { scope: true, windowStart: true, count: true },
      })).toEqual([
        { scope: AI_GENERATION_QUOTA_SCOPE, windowStart: billingWindowStart, count: 21 },
        { scope: COPILOT_USAGE_SCOPE, windowStart: billingWindowStart, count: 7 },
      ]);
      expect(await prisma.rateLimitCounter.findFirst({ where: { scope: "test", key: "expired-request" } })).toBeNull();
    } finally {
      random.mockRestore();
    }
  });

  it("never persists anything beyond scope/key/windowStart/count — no request metadata, IP details, or identifiers beyond the caller-supplied key", async () => {
    await checkRateLimit("test", "key-shape", policy, new Date("2026-01-01T00:00:00.000Z"));
    const rows = await prisma.rateLimitCounter.findMany({ where: { scope: "test", key: "key-shape" } });
    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0]!).sort();
    expect(keys).toEqual(["count", "id", "key", "scope", "updatedAt", "windowStart"]);
  });
});
