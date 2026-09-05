import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { CheckoutAlreadyInProgressError, createCheckoutSession, InvalidCheckoutPlanError } from "./checkout";
import { PLAN_ENTITLEMENTS } from "./plans";
import { createTestBillingProvider } from "./providers/test";
import type { BillingPaymentId, CheckoutSession, CreateCheckoutInput } from "./types";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("createCheckoutSession", () => {
  it("creates a real BillingCheckoutSession row before calling the vendor, with the amount read from the plan catalog", async () => {
    const { organization } = await createTestOrganization();
    let seenInput: CreateCheckoutInput | undefined;
    const provider = createTestBillingProvider({
      nextCheckoutResult: (input) => {
        seenInput = input;
        return { externalPaymentId: "pay_1" as BillingPaymentId, checkoutUrl: "https://billing.test.invalid/checkout/1" };
      },
    });

    const result = await createCheckoutSession(organization.id, "STARTER", { provider });

    expect(result.checkoutUrl).toBe("https://billing.test.invalid/checkout/1");
    expect(seenInput?.amountMinor).toBe(PLAN_ENTITLEMENTS.STARTER.priceMinor);
    expect(seenInput?.currency).toBe(PLAN_ENTITLEMENTS.STARTER.currency);

    const session = await prisma.billingCheckoutSession.findUniqueOrThrow({
      where: { id: result.checkoutSessionId },
    });
    expect(session).toMatchObject({
      organizationId: organization.id,
      targetPlanId: "STARTER",
      status: "PENDING",
      externalPaymentId: "pay_1",
      amountMinor: PLAN_ENTITLEMENTS.STARTER.priceMinor,
      currency: PLAN_ENTITLEMENTS.STARTER.currency,
    });

    const activity = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, type: "CHECKOUT_SESSION_CREATED" },
    });
    expect(activity).toHaveLength(1);
  });

  it("rejects a target plan that is not ranked above the current plan (lateral/downgrade never goes through checkout)", async () => {
    const { organization } = await createTestOrganization();
    const provider = createTestBillingProvider();

    await expect(createCheckoutSession(organization.id, "FREE", { provider })).rejects.toThrow(
      InvalidCheckoutPlanError,
    );
  });

  it("computes the amount from PLAN_ENTITLEMENTS, never from anything the caller passes in", async () => {
    const { organization } = await createTestOrganization();
    let seenInput: CreateCheckoutInput | undefined;
    const provider = createTestBillingProvider({
      nextCheckoutResult: (input) => {
        seenInput = input;
        return { externalPaymentId: "pay_amt" as BillingPaymentId, checkoutUrl: "https://billing.test.invalid/x" };
      },
    });

    await createCheckoutSession(organization.id, "PRO", { provider });

    expect(seenInput?.amountMinor).toBe(PLAN_ENTITLEMENTS.PRO.priceMinor);
  });

  it("rejects a second checkout while a non-stale one is already PENDING for the same organization", async () => {
    const { organization } = await createTestOrganization();
    const provider = createTestBillingProvider({
      nextCheckoutResult: (): CheckoutSession => ({
        externalPaymentId: `pay_${Math.random()}` as BillingPaymentId,
        checkoutUrl: "https://billing.test.invalid/x",
      }),
    });

    await createCheckoutSession(organization.id, "STARTER", { provider });

    await expect(createCheckoutSession(organization.id, "BUSINESS", { provider })).rejects.toThrow(
      CheckoutAlreadyInProgressError,
    );

    const sessions = await prisma.billingCheckoutSession.findMany({ where: { organizationId: organization.id } });
    expect(sessions).toHaveLength(1);
  });

  it("allows a new checkout once the previous PENDING one is stale (older than the window)", async () => {
    const { organization } = await createTestOrganization();
    const firstProvider = createTestBillingProvider({
      nextCheckoutResult: () => ({
        externalPaymentId: "pay_stale" as BillingPaymentId,
        checkoutUrl: "https://billing.test.invalid/stale",
      }),
    });
    const first = await createCheckoutSession(organization.id, "STARTER", { provider: firstProvider });

    await prisma.billingCheckoutSession.update({
      where: { id: first.checkoutSessionId },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const secondProvider = createTestBillingProvider({
      nextCheckoutResult: () => ({
        externalPaymentId: "pay_fresh" as BillingPaymentId,
        checkoutUrl: "https://billing.test.invalid/fresh",
      }),
    });
    const second = await createCheckoutSession(organization.id, "BUSINESS", { provider: secondProvider });

    expect(second.checkoutSessionId).not.toBe(first.checkoutSessionId);
    const sessions = await prisma.billingCheckoutSession.findMany({ where: { organizationId: organization.id } });
    expect(sessions).toHaveLength(2);
  });

  it("marks the checkout session FAILED (not left PENDING) when the vendor call itself throws, and does not block a retry", async () => {
    const { organization } = await createTestOrganization();
    const failingProvider = createTestBillingProvider({
      nextCheckoutResult: () => {
        throw new Error("simulated vendor network failure");
      },
    });

    await expect(createCheckoutSession(organization.id, "STARTER", { provider: failingProvider })).rejects.toThrow(
      "simulated vendor network failure",
    );

    const failedSession = await prisma.billingCheckoutSession.findFirstOrThrow({
      where: { organizationId: organization.id },
    });
    expect(failedSession.status).toBe("FAILED");

    const workingProvider = createTestBillingProvider({
      nextCheckoutResult: () => ({
        externalPaymentId: "pay_retry" as BillingPaymentId,
        checkoutUrl: "https://billing.test.invalid/retry",
      }),
    });
    const retried = await createCheckoutSession(organization.id, "STARTER", { provider: workingProvider });
    expect(retried.checkoutUrl).toBe("https://billing.test.invalid/retry");
  });

  it("tenant isolation: two organizations can each have their own concurrent PENDING checkout without colliding", async () => {
    const { organization: orgA } = await createTestOrganization();
    const { organization: orgB } = await createTestOrganization();
    const providerA = createTestBillingProvider({
      nextCheckoutResult: () => ({
        externalPaymentId: "pay_org_a" as BillingPaymentId,
        checkoutUrl: "https://billing.test.invalid/a",
      }),
    });
    const providerB = createTestBillingProvider({
      nextCheckoutResult: () => ({
        externalPaymentId: "pay_org_b" as BillingPaymentId,
        checkoutUrl: "https://billing.test.invalid/b",
      }),
    });

    await createCheckoutSession(orgA.id, "STARTER", { provider: providerA });
    await createCheckoutSession(orgB.id, "STARTER", { provider: providerB });

    expect(await prisma.billingCheckoutSession.count({ where: { organizationId: orgA.id } })).toBe(1);
    expect(await prisma.billingCheckoutSession.count({ where: { organizationId: orgB.id } })).toBe(1);
  });
});
