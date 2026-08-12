import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { getAutomationHealth } from "./health";

beforeEach(async () => {
  await resetDatabase();
});

function makeRun(overrides: Partial<Parameters<typeof prisma.automationTickRun.create>[0]["data"]> = {}) {
  return prisma.automationTickRun.create({
    data: {
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:05.000Z"),
      durationMs: 5000,
      globallyDisabled: false,
      organizationsProcessed: 3,
      organizationsRemaining: 0,
      scanned: 3,
      enrolled: 0,
      claimed: 1,
      executed: 1,
      skipped: 0,
      stopped: 0,
      blocked: 0,
      failed: 0,
      crashed: false,
      ...overrides,
    },
  });
}

describe("getAutomationHealth", () => {
  it("is live, and ready by definition, when automation is disabled — nothing is expected to be running", async () => {
    const health = await getAutomationHealth(new Date(), false);
    expect(health.live).toBe(true);
    expect(health.ready).toBe(true);
    expect(health.lastTickAt).toBeNull();
    expect(health.recentTicks).toEqual([]);
  });

  it("reports the most recent tick's timestamp and crashed state", async () => {
    await makeRun({ startedAt: new Date("2026-01-01T00:00:00.000Z") });
    await makeRun({ startedAt: new Date("2026-01-01T01:00:00.000Z") });

    const health = await getAutomationHealth(new Date("2026-01-01T01:05:00.000Z"));
    expect(health.lastTickAt).toBe(new Date("2026-01-01T01:00:00.000Z").toISOString());
    expect(health.lastTickCrashed).toBe(false);
  });

  it("lastSuccessfulTickAt skips crashed/globally-disabled runs and finds the most recent real success", async () => {
    await makeRun({ startedAt: new Date("2026-01-01T00:00:00.000Z"), crashed: false });
    await makeRun({ startedAt: new Date("2026-01-01T01:00:00.000Z"), crashed: true, errorMessage: "boom" });

    const health = await getAutomationHealth(new Date("2026-01-01T01:05:00.000Z"));
    expect(health.lastTickAt).toBe(new Date("2026-01-01T01:00:00.000Z").toISOString());
    expect(health.lastTickCrashed).toBe(true);
    expect(health.lastSuccessfulTickAt).toBe(new Date("2026-01-01T00:00:00.000Z").toISOString());
  });

  it("never exposes customer data, message content, or provider secrets — only counts and timestamps", async () => {
    await makeRun();
    const health = await getAutomationHealth();
    const json = JSON.stringify(health);
    expect(json).not.toMatch(/@/); // no email-shaped strings
    const allowedTopLevelKeys = [
      "live",
      "ready",
      "automationEnabled",
      "lastTickAt",
      "lastTickCrashed",
      "lastSuccessfulTickAt",
      "recentTicks",
    ];
    expect(Object.keys(health).sort()).toEqual([...allowedTopLevelKeys].sort());
  });

  it("caps recentTicks at a bounded number even when many runs exist", async () => {
    for (let i = 0; i < 15; i++) {
      await makeRun({ startedAt: new Date(Date.UTC(2026, 0, 1, i)) });
    }
    const health = await getAutomationHealth();
    expect(health.recentTicks.length).toBeLessThanOrEqual(10);
  });
});

describe("getAutomationHealth — readiness semantics (automationEnabled=true)", () => {
  it("is ready when the most recent tick is fresh and did not crash", async () => {
    await makeRun({ startedAt: new Date("2026-01-01T00:00:00.000Z"), crashed: false });
    const health = await getAutomationHealth(new Date("2026-01-01T00:05:00.000Z"), true);
    expect(health.ready).toBe(true);
  });

  it("is NOT ready when automation is enabled but no tick has ever run — the scheduler appears never to have fired", async () => {
    const health = await getAutomationHealth(new Date(), true);
    expect(health.ready).toBe(false);
  });

  it("is NOT ready when the most recent tick is stale (scheduler appears to have stopped)", async () => {
    await makeRun({ startedAt: new Date("2026-01-01T00:00:00.000Z"), crashed: false });
    // Far beyond STALE_TICK_THRESHOLD_MS (3 hours) after the last tick.
    const health = await getAutomationHealth(new Date("2026-01-02T00:00:00.000Z"), true);
    expect(health.ready).toBe(false);
  });

  it("is NOT ready when the most recent tick crashed, even if it was recent", async () => {
    await makeRun({ startedAt: new Date("2026-01-01T00:00:00.000Z"), crashed: true, errorMessage: "db unreachable" });
    const health = await getAutomationHealth(new Date("2026-01-01T00:05:00.000Z"), true);
    expect(health.ready).toBe(false);
  });

  it("is ready again once a fresh, non-crashed tick follows a crashed one — readiness reflects the latest state, not history", async () => {
    await makeRun({ startedAt: new Date("2026-01-01T00:00:00.000Z"), crashed: true, errorMessage: "db unreachable" });
    await makeRun({ startedAt: new Date("2026-01-01T01:00:00.000Z"), crashed: false });
    const health = await getAutomationHealth(new Date("2026-01-01T01:05:00.000Z"), true);
    expect(health.ready).toBe(true);
  });

  it("a single failed organization within an otherwise-successful tick does not make the run 'crashed' or unready", async () => {
    await makeRun({ startedAt: new Date("2026-01-01T00:00:00.000Z"), crashed: false, failed: 1, organizationsProcessed: 3 });
    const health = await getAutomationHealth(new Date("2026-01-01T00:05:00.000Z"), true);
    expect(health.ready).toBe(true);
  });
});
