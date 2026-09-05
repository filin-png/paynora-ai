import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { applySubscriptionWebhookEvent, mapNormalizedStatus } from "./webhook-events";
import type { BillingCustomerId, BillingSubscriptionId, NormalizedSubscriptionEvent } from "./types";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

async function linkBilling(organizationId: string, opts: { customerId: string; subscriptionId: string; provider?: string }) {
  await prisma.organizationSubscription.update({
    where: { organizationId },
    data: {
      billingProvider: opts.provider ?? "yookassa",
      externalCustomerId: opts.customerId,
      externalSubscriptionId: opts.subscriptionId,
    },
  });
}

function makeEvent(overrides: Partial<NormalizedSubscriptionEvent> = {}): NormalizedSubscriptionEvent {
  return {
    eventIdentity: { provider: "yookassa", eventId: "evt_1" },
    customerId: "cus_1" as BillingCustomerId,
    subscriptionId: "sub_1" as BillingSubscriptionId,
    // A brand-new OrganizationSubscription already defaults to ACTIVE (see
    // createTestOrganization) — "trialing" is used here rather than
    // "active" so most tests exercise a real status transition instead of
    // a same-status no-op.
    status: "trialing",
    ...overrides,
  };
}

describe("mapNormalizedStatus", () => {
  it("maps every vendor-neutral status to PAYNORA's own SubscriptionStatus, or null for incomplete", () => {
    expect(mapNormalizedStatus("active")).toBe("ACTIVE");
    expect(mapNormalizedStatus("trialing")).toBe("TRIALING");
    expect(mapNormalizedStatus("past_due")).toBe("PAST_DUE");
    expect(mapNormalizedStatus("unpaid")).toBe("PAST_DUE");
    expect(mapNormalizedStatus("canceled")).toBe("CANCELED");
    expect(mapNormalizedStatus("incomplete")).toBeNull();
  });
});

describe("applySubscriptionWebhookEvent", () => {
  it("resolves 'unknown_organization' when no subscription is linked to the event's customer/subscription id", async () => {
    const result = await applySubscriptionWebhookEvent(makeEvent());

    expect(result).toEqual({ outcome: "unknown_organization" });
    expect(await prisma.subscriptionPayment.count()).toBe(0);
  });

  it("applies a first-time event: writes a ledger row, transitions status, records an activity event", async () => {
    const { organization } = await createTestOrganization();
    await linkBilling(organization.id, { customerId: "cus_1", subscriptionId: "sub_1" });

    const result = await applySubscriptionWebhookEvent(
      makeEvent({ amountMinor: 199000n, currency: "RUB", planId: "price_starter_rub" }),
    );

    expect(result).toEqual({ outcome: "applied", organizationId: organization.id, statusChanged: true });

    const subscription = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: organization.id },
    });
    expect(subscription.status).toBe("TRIALING");
    // Plan is never touched by a webhook event — see webhook-events.ts's doc comment.
    expect(subscription.plan).toBe("FREE");

    const ledgerRows = await prisma.subscriptionPayment.findMany({ where: { organizationId: organization.id } });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      provider: "yookassa",
      externalEventId: "evt_1",
      amountMinor: 199000n,
      currency: "RUB",
      status: "TRIALING",
      planIdRaw: "price_starter_rub",
    });

    const activityEvents = await prisma.activityEvent.findMany({ where: { organizationId: organization.id } });
    expect(activityEvents).toHaveLength(1);
    expect(activityEvents[0].type).toBe("SUBSCRIPTION_STATUS_CHANGED");
  });

  it("is idempotent: redelivering the same (provider, eventId) is a no-op the second time", async () => {
    const { organization } = await createTestOrganization();
    await linkBilling(organization.id, { customerId: "cus_1", subscriptionId: "sub_1" });

    const first = await applySubscriptionWebhookEvent(makeEvent());
    expect(first.outcome).toBe("applied");

    const second = await applySubscriptionWebhookEvent(makeEvent());
    expect(second).toEqual({ outcome: "duplicate", organizationId: organization.id });

    expect(await prisma.subscriptionPayment.count({ where: { organizationId: organization.id } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { organizationId: organization.id } })).toBe(1);
  });

  it("a distinct eventId with the same resulting status still appends a ledger row without a duplicate activity event", async () => {
    const { organization } = await createTestOrganization();
    await linkBilling(organization.id, { customerId: "cus_1", subscriptionId: "sub_1" });

    await applySubscriptionWebhookEvent(makeEvent({ eventIdentity: { provider: "yookassa", eventId: "evt_1" } }));
    const second = await applySubscriptionWebhookEvent(
      makeEvent({ eventIdentity: { provider: "yookassa", eventId: "evt_2" } }),
    );

    expect(second).toEqual({ outcome: "applied", organizationId: organization.id, statusChanged: false });
    expect(await prisma.subscriptionPayment.count({ where: { organizationId: organization.id } })).toBe(2);
    // No status transition on the second delivery, so no second activity event.
    expect(await prisma.activityEvent.count({ where: { organizationId: organization.id } })).toBe(1);
  });

  it("'incomplete' is recorded in the ledger but never changes OrganizationSubscription.status", async () => {
    const { organization } = await createTestOrganization();
    await linkBilling(organization.id, { customerId: "cus_1", subscriptionId: "sub_1" });

    const result = await applySubscriptionWebhookEvent(makeEvent({ status: "incomplete" }));

    expect(result).toEqual({ outcome: "applied", organizationId: organization.id, statusChanged: false });
    const subscription = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: organization.id },
    });
    expect(subscription.status).toBe("ACTIVE");
    const ledgerRows = await prisma.subscriptionPayment.findMany({ where: { organizationId: organization.id } });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].status).toBe("ACTIVE"); // ledger records the *current* status when the event carries none of its own
  });

  it("an event with no amount/currency records null in the ledger rather than a fabricated figure", async () => {
    const { organization } = await createTestOrganization();
    await linkBilling(organization.id, { customerId: "cus_1", subscriptionId: "sub_1" });

    await applySubscriptionWebhookEvent(makeEvent());

    const [row] = await prisma.subscriptionPayment.findMany({ where: { organizationId: organization.id } });
    expect(row.amountMinor).toBeNull();
    expect(row.currency).toBeNull();
  });

  it("tenant isolation: an event for organization A's customer id never touches organization B's subscription", async () => {
    const { organization: orgA } = await createTestOrganization();
    const { organization: orgB } = await createTestOrganization();
    await linkBilling(orgA.id, { customerId: "cus_a", subscriptionId: "sub_a" });
    await linkBilling(orgB.id, { customerId: "cus_b", subscriptionId: "sub_b" });

    const result = await applySubscriptionWebhookEvent(
      makeEvent({ customerId: "cus_a" as BillingCustomerId, subscriptionId: "sub_a" as BillingSubscriptionId }),
    );

    expect(result).toMatchObject({ outcome: "applied", organizationId: orgA.id });
    expect(await prisma.subscriptionPayment.count({ where: { organizationId: orgB.id } })).toBe(0);
    const orgBSubscription = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: orgB.id },
    });
    expect(orgBSubscription.status).toBe("ACTIVE");
  });

  it("only matches events whose provider matches the linked billingProvider, even if ids collide", async () => {
    const { organization } = await createTestOrganization();
    await linkBilling(organization.id, { customerId: "cus_1", subscriptionId: "sub_1", provider: "yookassa" });

    const result = await applySubscriptionWebhookEvent(
      makeEvent({ eventIdentity: { provider: "stripe", eventId: "evt_1" } }),
    );

    expect(result).toEqual({ outcome: "unknown_organization" });
  });

  it("an event with a paymentId but no matching customer/subscription link never falls back to the legacy OR-lookup", async () => {
    // Regression guard: paymentId-carrying events must resolve ONLY via
    // BillingCheckoutSession — never via the legacy OR-lookup, even if a
    // customerId/subscriptionId happens to also be present and would
    // otherwise match something.
    const { organization } = await createTestOrganization();
    await linkBilling(organization.id, { customerId: "cus_1", subscriptionId: "sub_1" });

    const result = await applySubscriptionWebhookEvent(
      makeEvent({ paymentId: "pay_unlinked" as NormalizedSubscriptionEvent["paymentId"] }),
    );

    expect(result).toEqual({ outcome: "unknown_organization" });
    expect(await prisma.subscriptionPayment.count()).toBe(0);
  });

  it("an event with neither paymentId nor customerId/subscriptionId resolves to unknown_organization without an unconstrained query", async () => {
    const { organization } = await createTestOrganization();
    await linkBilling(organization.id, { customerId: "cus_1", subscriptionId: "sub_1" });

    const result = await applySubscriptionWebhookEvent(
      makeEvent({ customerId: undefined, subscriptionId: undefined }),
    );

    expect(result).toEqual({ outcome: "unknown_organization" });
  });
});

describe("applySubscriptionWebhookEvent — checkout-driven path (Phase 20)", () => {
  async function createCheckoutFixture(
    organizationId: string,
    opts: {
      provider?: string;
      targetPlanId?: "STARTER" | "BUSINESS" | "PRO";
      externalPaymentId?: string;
      status?: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELED";
      amountMinor?: bigint;
      currency?: string;
    } = {},
  ) {
    return prisma.billingCheckoutSession.create({
      data: {
        organizationId,
        provider: opts.provider ?? "yookassa",
        targetPlanId: opts.targetPlanId ?? "STARTER",
        status: opts.status ?? "PENDING",
        amountMinor: opts.amountMinor ?? 199000n,
        currency: opts.currency ?? "RUB",
        externalPaymentId: opts.externalPaymentId ?? "pay_1",
        idempotencyKey: `idem-${Math.random()}`,
      },
    });
  }

  function makeCheckoutEvent(overrides: Partial<NormalizedSubscriptionEvent> = {}): NormalizedSubscriptionEvent {
    return {
      eventIdentity: { provider: "yookassa", eventId: "evt_pay_1:payment.succeeded" },
      paymentId: "pay_1" as NormalizedSubscriptionEvent["paymentId"],
      status: "active",
      ...overrides,
    };
  }

  it("a succeeded checkout event grants the checkout session's targetPlanId — never event.planId — and activates the subscription", async () => {
    const { organization } = await createTestOrganization();
    await createCheckoutFixture(organization.id, { targetPlanId: "BUSINESS", amountMinor: 499000n });

    const result = await applySubscriptionWebhookEvent(
      // event.planId deliberately claims a different, higher plan — must be
      // ignored entirely; only the checkout session's own targetPlanId is
      // ever granted.
      makeCheckoutEvent({ planId: "PRO", amountMinor: 499000n, currency: "RUB" }),
    );

    expect(result).toEqual({ outcome: "applied", organizationId: organization.id, statusChanged: true });

    const subscription = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: organization.id },
    });
    expect(subscription.plan).toBe("BUSINESS");
    expect(subscription.status).toBe("ACTIVE");

    const session = await prisma.billingCheckoutSession.findFirstOrThrow({
      where: { organizationId: organization.id },
    });
    expect(session.status).toBe("SUCCEEDED");

    const ledger = await prisma.subscriptionPayment.findMany({ where: { organizationId: organization.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: "ACTIVE", planIdRaw: "PRO" });

    const activity = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, type: "SUBSCRIPTION_STATUS_CHANGED" },
    });
    expect(activity).toHaveLength(1);
  });

  it("a failed/canceled checkout event fails only the checkout session — never touches an existing active subscription", async () => {
    const { organization } = await createTestOrganization();
    // Give the organization a real, already-active paid plan first — a
    // failed *new* upgrade attempt must never revert this.
    await prisma.organizationSubscription.update({
      where: { organizationId: organization.id },
      data: { plan: "STARTER", status: "ACTIVE" },
    });
    await createCheckoutFixture(organization.id, { targetPlanId: "PRO", externalPaymentId: "pay_fail" });

    const result = await applySubscriptionWebhookEvent(
      makeCheckoutEvent({
        eventIdentity: { provider: "yookassa", eventId: "evt_pay_fail:payment.canceled" },
        paymentId: "pay_fail" as NormalizedSubscriptionEvent["paymentId"],
        status: "canceled",
      }),
    );

    expect(result).toEqual({ outcome: "applied", organizationId: organization.id, statusChanged: false });

    const subscription = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: organization.id },
    });
    expect(subscription.plan).toBe("STARTER");
    expect(subscription.status).toBe("ACTIVE");

    const session = await prisma.billingCheckoutSession.findFirstOrThrow({
      where: { organizationId: organization.id },
    });
    expect(session.status).toBe("FAILED");
  });

  it("a succeeded event whose reported amount/currency doesn't match the checkout session's authorized amount is refused — session FAILED, no plan grant", async () => {
    const { organization } = await createTestOrganization();
    await createCheckoutFixture(organization.id, {
      targetPlanId: "PRO",
      externalPaymentId: "pay_mismatch",
      amountMinor: 999000n,
      currency: "RUB",
    });

    const result = await applySubscriptionWebhookEvent(
      makeCheckoutEvent({
        eventIdentity: { provider: "yookassa", eventId: "evt_pay_mismatch" },
        paymentId: "pay_mismatch" as NormalizedSubscriptionEvent["paymentId"],
        status: "active",
        // Reports a much smaller amount than PRO actually costs — must
        // never be treated as "paid for Starter, granted Pro".
        amountMinor: 199000n,
        currency: "RUB",
      }),
    );

    expect(result).toEqual({ outcome: "applied", organizationId: organization.id, statusChanged: false });

    const subscription = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: organization.id },
    });
    expect(subscription.plan).toBe("FREE");

    const session = await prisma.billingCheckoutSession.findFirstOrThrow({
      where: { organizationId: organization.id },
    });
    expect(session.status).toBe("FAILED");
  });

  it("a pending checkout event (e.g. waiting_for_capture) only records the ledger row — no plan grant, no session status change", async () => {
    const { organization } = await createTestOrganization();
    await createCheckoutFixture(organization.id, { externalPaymentId: "pay_pending" });

    const result = await applySubscriptionWebhookEvent(
      makeCheckoutEvent({
        eventIdentity: { provider: "yookassa", eventId: "evt_pay_pending:payment.waiting_for_capture" },
        paymentId: "pay_pending" as NormalizedSubscriptionEvent["paymentId"],
        status: "incomplete",
      }),
    );

    expect(result).toEqual({ outcome: "applied", organizationId: organization.id, statusChanged: false });

    const session = await prisma.billingCheckoutSession.findFirstOrThrow({
      where: { organizationId: organization.id },
    });
    expect(session.status).toBe("PENDING");

    const subscription = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: organization.id },
    });
    expect(subscription.plan).toBe("FREE");
  });

  it("is idempotent: redelivering the exact same checkout webhook event is a no-op the second time", async () => {
    const { organization } = await createTestOrganization();
    await createCheckoutFixture(organization.id);

    const first = await applySubscriptionWebhookEvent(makeCheckoutEvent());
    expect(first.outcome).toBe("applied");

    const second = await applySubscriptionWebhookEvent(makeCheckoutEvent());
    expect(second).toEqual({ outcome: "duplicate", organizationId: organization.id });

    expect(await prisma.subscriptionPayment.count({ where: { organizationId: organization.id } })).toBe(1);
    const subscription = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: organization.id },
    });
    expect(subscription.plan).toBe("STARTER");
  });

  it("race/concurrency: two distinct succeeded deliveries for the same checkout session grant the plan only once", async () => {
    const { organization } = await createTestOrganization();
    await createCheckoutFixture(organization.id);

    const first = await applySubscriptionWebhookEvent(
      makeCheckoutEvent({ eventIdentity: { provider: "yookassa", eventId: "evt_a" } }),
    );
    const second = await applySubscriptionWebhookEvent(
      makeCheckoutEvent({ eventIdentity: { provider: "yookassa", eventId: "evt_b" } }),
    );

    expect(first).toEqual({ outcome: "applied", organizationId: organization.id, statusChanged: true });
    // Second delivery: a distinct eventId (not deduped by the ledger's own
    // unique constraint) but the checkout session's PENDING -> SUCCEEDED
    // compare-and-swap has already been claimed by the first, so this one
    // records a ledger row but grants nothing a second time.
    expect(second).toEqual({ outcome: "applied", organizationId: organization.id, statusChanged: false });

    expect(await prisma.subscriptionPayment.count({ where: { organizationId: organization.id } })).toBe(2);
    const activity = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, type: "SUBSCRIPTION_STATUS_CHANGED" },
    });
    expect(activity).toHaveLength(1);
  });

  it("resolves 'unknown_organization' for a paymentId with no matching BillingCheckoutSession (incorrect/forged vendor id)", async () => {
    const result = await applySubscriptionWebhookEvent(
      makeCheckoutEvent({ paymentId: "pay_never_created" as NormalizedSubscriptionEvent["paymentId"] }),
    );

    expect(result).toEqual({ outcome: "unknown_organization" });
  });

  it("resolves 'unknown_organization' when the checkout session's provider doesn't match the event's provider (cross-provider id confusion)", async () => {
    const { organization } = await createTestOrganization();
    await createCheckoutFixture(organization.id, { provider: "stripe" });

    const result = await applySubscriptionWebhookEvent(
      makeCheckoutEvent({ eventIdentity: { provider: "yookassa", eventId: "evt_pay_1" } }),
    );

    expect(result).toEqual({ outcome: "unknown_organization" });
    expect(await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: organization.id } })).toMatchObject(
      { plan: "FREE" },
    );
  });

  it("tenant isolation: a checkout event for organization A's paymentId never touches organization B", async () => {
    const { organization: orgA } = await createTestOrganization();
    const { organization: orgB } = await createTestOrganization();
    await createCheckoutFixture(orgA.id, { externalPaymentId: "pay_org_a", targetPlanId: "PRO" });
    await createCheckoutFixture(orgB.id, { externalPaymentId: "pay_org_b", targetPlanId: "PRO" });

    const result = await applySubscriptionWebhookEvent(
      makeCheckoutEvent({
        eventIdentity: { provider: "yookassa", eventId: "evt_org_a" },
        paymentId: "pay_org_a" as NormalizedSubscriptionEvent["paymentId"],
      }),
    );

    expect(result).toMatchObject({ outcome: "applied", organizationId: orgA.id });
    const orgBSubscription = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: orgB.id },
    });
    expect(orgBSubscription.plan).toBe("FREE");
    expect(await prisma.subscriptionPayment.count({ where: { organizationId: orgB.id } })).toBe(0);
  });
});
