import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { getOrganizationSubscriptionPayments } from "./payment-history";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

async function insertPayment(organizationId: string, overrides: Partial<{ provider: string; externalEventId: string }> = {}) {
  return prisma.subscriptionPayment.create({
    data: {
      organizationId,
      provider: overrides.provider ?? "yookassa",
      externalEventId: overrides.externalEventId ?? `evt_${Math.random().toString(36).slice(2)}`,
      amountMinor: 199000n,
      currency: "RUB",
      status: "ACTIVE",
    },
  });
}

describe("getOrganizationSubscriptionPayments", () => {
  it("returns this organization's own payments, most recent first", async () => {
    const { organization } = await createTestOrganization();
    const first = await insertPayment(organization.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await insertPayment(organization.id);

    const rows = await getOrganizationSubscriptionPayments(organization.id);

    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it("tenant isolation: never returns another organization's payments", async () => {
    const { organization: orgA } = await createTestOrganization();
    const { organization: orgB } = await createTestOrganization();
    await insertPayment(orgA.id);

    const rowsB = await getOrganizationSubscriptionPayments(orgB.id);

    expect(rowsB).toHaveLength(0);
  });

  it("returns an empty array, not an error, for an organization with no payment history", async () => {
    const { organization } = await createTestOrganization();
    const rows = await getOrganizationSubscriptionPayments(organization.id);
    expect(rows).toEqual([]);
  });

  it("respects the limit parameter", async () => {
    const { organization } = await createTestOrganization();
    for (let i = 0; i < 5; i++) {
      await insertPayment(organization.id);
    }

    const rows = await getOrganizationSubscriptionPayments(organization.id, 3);

    expect(rows).toHaveLength(3);
  });
});
