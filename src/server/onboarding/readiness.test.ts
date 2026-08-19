import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { setOrganizationPlan } from "@/server/billing/subscription";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { getReadinessState } from "./readiness";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("getReadinessState", () => {
  it("honestly reports the test environment's providers as not configured (AI_PROVIDER/EMAIL_PROVIDER default to none)", async () => {
    const { organization } = await createTestOrganization();

    const state = await getReadinessState(organization.id);

    const ai = state.checks.find((c) => c.label === "AI provider")!;
    const email = state.checks.find((c) => c.label === "Transactional email")!;
    expect(ai.ready).toBe(false);
    expect(ai.detail).toBe("Not configured");
    expect(email.ready).toBe(false);
    expect(email.detail).toBe("Not configured");
  });

  it("reports the test environment's default APP_BASE_URL (localhost) as not production-ready", async () => {
    const { organization } = await createTestOrganization();
    const state = await getReadinessState(organization.id);

    const baseUrl = state.checks.find((c) => c.label === "Application base URL")!;
    expect(baseUrl.ready).toBe(false);
    expect(baseUrl.detail).toContain("localhost");
  });

  it("reflects the organization's actual plan/entitlement state — collections automation flips ready once the plan allows it", async () => {
    const { organization } = await createTestOrganization();

    let state = await getReadinessState(organization.id);
    expect(state.checks.find((c) => c.label === "Collections automation")!.ready).toBe(false);

    await setOrganizationPlan(organization.id, "STARTER");
    state = await getReadinessState(organization.id);
    expect(state.checks.find((c) => c.label === "Collections automation")!.ready).toBe(true);
  });

  it("readyCount matches the number of ready checks", async () => {
    const { organization } = await createTestOrganization();
    const state = await getReadinessState(organization.id);
    expect(state.readyCount).toBe(state.checks.filter((c) => c.ready).length);
  });

  it("never exposes a secret — every check is exactly {label, ready, detail}, and no detail contains a key/token-shaped value", async () => {
    const { organization } = await createTestOrganization();
    const state = await getReadinessState(organization.id);

    for (const check of state.checks) {
      expect(Object.keys(check).sort()).toEqual(["detail", "label", "ready"]);
      expect(check.detail).not.toMatch(/sk-|api[_-]?key|secret|password/i);
    }
  });

  it("is tenant-scoped — one organization's plan never affects another's readiness", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    await setOrganizationPlan(orgA.id, "PRO");

    const stateB = await getReadinessState(orgB.id);
    expect(stateB.checks.find((c) => c.label === "Subscription")!.detail).toContain("FREE");
  });
});
