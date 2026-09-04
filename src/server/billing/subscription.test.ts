import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { getOrganizationEntitlements } from "./entitlements";
import {
  cancelOrganizationSubscription,
  changeOrganizationPlanSelfServe,
  InvalidSubscriptionTransitionError,
  reactivateOrganizationSubscription,
  setOrganizationPlan,
  UpgradeRequiresPaymentError,
} from "./subscription";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("setOrganizationPlan", () => {
  it("changes plan and status and records a PLAN_CHANGED activity event", async () => {
    const { organization } = await createTestOrganization();

    await setOrganizationPlan(organization.id, "STARTER");

    const result = await getOrganizationEntitlements(organization.id);
    expect(result.plan).toBe("STARTER");
    expect(result.status).toBe("ACTIVE");

    const events = await prisma.activityEvent.findMany({ where: { organizationId: organization.id } });
    expect(events.some((e) => e.type === "PLAN_CHANGED")).toBe(true);
  });

  it("is a no-op (no new activity event) when plan and status are already what's requested", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "STARTER");
    const countBefore = await prisma.activityEvent.count({ where: { organizationId: organization.id } });

    await setOrganizationPlan(organization.id, "STARTER", "ACTIVE");

    const countAfter = await prisma.activityEvent.count({ where: { organizationId: organization.id } });
    expect(countAfter).toBe(countBefore);
  });
});

describe("changeOrganizationPlanSelfServe — safe by construction (Phase 19 section 10 bypass check)", () => {
  it("allows a downgrade to a lower-ranked plan", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "PRO");

    await changeOrganizationPlanSelfServe(organization.id, "STARTER");

    const result = await getOrganizationEntitlements(organization.id);
    expect(result.plan).toBe("STARTER");
  });

  it("allows a lateral change to the same plan", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "BUSINESS");

    await expect(changeOrganizationPlanSelfServe(organization.id, "BUSINESS")).resolves.toBeUndefined();
  });

  it("throws UpgradeRequiresPaymentError for any higher-ranked plan and never changes stored state", async () => {
    const { organization } = await createTestOrganization();
    // FREE -> BUSINESS would be an upgrade; must be rejected regardless of what a client requests.
    await expect(changeOrganizationPlanSelfServe(organization.id, "BUSINESS")).rejects.toThrow(
      UpgradeRequiresPaymentError,
    );

    const result = await getOrganizationEntitlements(organization.id);
    expect(result.plan).toBe("FREE");
  });

  it("rejects an upgrade attempt even from a plan already partway up the ladder (STARTER -> PRO)", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "STARTER");

    await expect(changeOrganizationPlanSelfServe(organization.id, "PRO")).rejects.toThrow(UpgradeRequiresPaymentError);

    const result = await getOrganizationEntitlements(organization.id);
    expect(result.plan).toBe("STARTER");
  });
});

describe("cancelOrganizationSubscription / reactivateOrganizationSubscription", () => {
  it("cancel reverts effective access to FREE without touching the stored plan", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "PRO");

    await cancelOrganizationSubscription(organization.id);

    const result = await getOrganizationEntitlements(organization.id);
    expect(result.plan).toBe("FREE"); // effective, via CANCELED -> FREE
    const raw = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: organization.id } });
    expect(raw.plan).toBe("PRO"); // stored plan untouched
    expect(raw.status).toBe("CANCELED");
  });

  it("reactivate restores exactly the plan that was canceled — never a higher one", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "PRO");
    await cancelOrganizationSubscription(organization.id);

    await reactivateOrganizationSubscription(organization.id);

    const result = await getOrganizationEntitlements(organization.id);
    expect(result.plan).toBe("PRO");
    expect(result.status).toBe("ACTIVE");
  });

  it("reactivate throws InvalidSubscriptionTransitionError when not currently canceled", async () => {
    const { organization } = await createTestOrganization();

    await expect(reactivateOrganizationSubscription(organization.id)).rejects.toThrow(
      InvalidSubscriptionTransitionError,
    );
  });

  it("cancel is idempotent (a second cancel is a no-op, not an error)", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "STARTER");
    await cancelOrganizationSubscription(organization.id);

    await expect(cancelOrganizationSubscription(organization.id)).resolves.toBeUndefined();
    const raw = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: organization.id } });
    expect(raw.status).toBe("CANCELED");
  });

  it("tenant isolation: canceling organization A never touches organization B's subscription", async () => {
    const { organization: orgA } = await createTestOrganization();
    const { organization: orgB } = await createTestOrganization();
    await setOrganizationPlan(orgA.id, "PRO");
    await setOrganizationPlan(orgB.id, "PRO");

    await cancelOrganizationSubscription(orgA.id);

    const orgBResult = await getOrganizationEntitlements(orgB.id);
    expect(orgBResult.plan).toBe("PRO");
    expect(orgBResult.status).toBe("ACTIVE");
  });
});
