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
});
