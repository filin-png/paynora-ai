import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { cancelInvoice, createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { setOrganizationPlan } from "./subscription";
import {
  assertWithinResourceLimit,
  EntitlementLimitExceededError,
  getOrganizationEntitlements,
  getOrganizationUsage,
} from "./entitlements";
import { limitMax, PLAN_ENTITLEMENTS } from "./plans";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

async function createInvoiceFor(organizationId: string, customerId: string, number: string) {
  return createInvoice(organizationId, {
    customerId,
    number,
    currency: "USD",
    amountMinor: majorToMinor(100),
    issueDate: "2020-01-01",
    dueDate: "2020-02-01",
  });
}

describe("getOrganizationEntitlements", () => {
  it("a brand-new organization defaults to FREE/ACTIVE", async () => {
    const { organization } = await createTestOrganization();

    const result = await getOrganizationEntitlements(organization.id);

    expect(result.plan).toBe("FREE");
    expect(result.status).toBe("ACTIVE");
    expect(result.entitlements).toEqual(PLAN_ENTITLEMENTS.FREE);
  });

  it("returns deterministic, distinct entitlements for FREE/STARTER/PRO", async () => {
    const { organization } = await createTestOrganization();

    await setOrganizationPlan(organization.id, "STARTER");
    expect((await getOrganizationEntitlements(organization.id)).entitlements).toEqual(PLAN_ENTITLEMENTS.STARTER);

    await setOrganizationPlan(organization.id, "PRO");
    expect((await getOrganizationEntitlements(organization.id)).entitlements).toEqual(PLAN_ENTITLEMENTS.PRO);

    expect(PLAN_ENTITLEMENTS.FREE).not.toEqual(PLAN_ENTITLEMENTS.STARTER);
    expect(PLAN_ENTITLEMENTS.STARTER).not.toEqual(PLAN_ENTITLEMENTS.PRO);
  });

  it("ACTIVE, TRIALING, and PAST_DUE all grant the subscribed plan's entitlements", async () => {
    const { organization } = await createTestOrganization();

    for (const status of ["ACTIVE", "TRIALING", "PAST_DUE"] as const) {
      await setOrganizationPlan(organization.id, "STARTER", status);
      const result = await getOrganizationEntitlements(organization.id);
      expect(result.plan).toBe("STARTER");
      expect(result.entitlements).toEqual(PLAN_ENTITLEMENTS.STARTER);
    }
  });

  it("CANCELED reverts effective access to FREE regardless of the subscribed plan", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "PRO", "CANCELED");

    const result = await getOrganizationEntitlements(organization.id);

    expect(result.plan).toBe("FREE");
    expect(result.entitlements).toEqual(PLAN_ENTITLEMENTS.FREE);
  });
});

describe("plan changes", () => {
  it("upgrade takes effect immediately — a create blocked on FREE succeeds right after upgrading", async () => {
    const { organization } = await createTestOrganization();

    // Exhaust FREE's customer quota (25).
    for (let i = 0; i < limitMax(PLAN_ENTITLEMENTS.FREE.maxCustomers); i++) {
      await createCustomer(organization.id, { name: `Customer ${i}`, email: `c${i}@example.com` });
    }
    await expect(createCustomer(organization.id, { name: "One too many", email: "over@example.com" })).rejects.toThrow(
      EntitlementLimitExceededError,
    );

    await setOrganizationPlan(organization.id, "STARTER");

    await expect(
      createCustomer(organization.id, { name: "Now it fits", email: "fits@example.com" }),
    ).resolves.toBeDefined();
  }, 20000);

  it("downgrade preserves existing data and blocks only new creation while over the new limit", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "STARTER");

    for (let i = 0; i < 30; i++) {
      await createCustomer(organization.id, { name: `Customer ${i}`, email: `c${i}@example.com` });
    }
    const before = await prisma.customer.count({ where: { organizationId: organization.id } });
    expect(before).toBe(30); // over FREE's limit of 25, fine on STARTER

    await setOrganizationPlan(organization.id, "FREE");

    // Nothing was deleted.
    const afterDowngrade = await prisma.customer.count({ where: { organizationId: organization.id } });
    expect(afterDowngrade).toBe(30);

    // But new creation is blocked until usage drops back under the limit.
    await expect(
      createCustomer(organization.id, { name: "Blocked", email: "blocked@example.com" }),
    ).rejects.toThrow(EntitlementLimitExceededError);
  }, 20000);

  it("records a PLAN_CHANGED activity event only when plan or status actually changes", async () => {
    const { organization } = await createTestOrganization();

    await setOrganizationPlan(organization.id, "FREE", "ACTIVE"); // no-op — already FREE/ACTIVE
    await setOrganizationPlan(organization.id, "STARTER");

    const events = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, type: "PLAN_CHANGED" },
    });
    expect(events).toHaveLength(1);
  });
});

describe("assertWithinResourceLimit — customers", () => {
  it("allows creation below the limit", async () => {
    const { organization } = await createTestOrganization();
    await expect(createCustomer(organization.id, { name: "A", email: "a@example.com" })).resolves.toBeDefined();
  });

  it("denies creation at the limit", async () => {
    const { organization } = await createTestOrganization();
    for (let i = 0; i < limitMax(PLAN_ENTITLEMENTS.FREE.maxCustomers); i++) {
      await createCustomer(organization.id, { name: `Customer ${i}`, email: `c${i}@example.com` });
    }
    await expect(createCustomer(organization.id, { name: "Over", email: "over@example.com" })).rejects.toThrow(
      EntitlementLimitExceededError,
    );
  }, 20000);

  it("archived customers don't count toward usage — archiving frees up quota", async () => {
    const { organization } = await createTestOrganization();
    for (let i = 0; i < limitMax(PLAN_ENTITLEMENTS.FREE.maxCustomers); i++) {
      await createCustomer(organization.id, { name: `Customer ${i}`, email: `c${i}@example.com` });
    }
    const usageBefore = await getOrganizationUsage(organization.id);
    expect(usageBefore.customers).toBe(limitMax(PLAN_ENTITLEMENTS.FREE.maxCustomers));

    const firstCustomer = await prisma.customer.findFirstOrThrow({ where: { organizationId: organization.id } });
    await prisma.customer.update({ where: { id: firstCustomer.id }, data: { archivedAt: new Date() } });

    await expect(
      createCustomer(organization.id, { name: "Fits now", email: "fits@example.com" }),
    ).resolves.toBeDefined();
  }, 20000);

  it("concurrent creation cannot trivially exceed the quota", async () => {
    const { organization } = await createTestOrganization();
    const limit = limitMax(PLAN_ENTITLEMENTS.FREE.maxCustomers);
    // Pre-fill to one below the limit, then race several concurrent
    // creates for the last remaining slot.
    for (let i = 0; i < limit - 1; i++) {
      await createCustomer(organization.id, { name: `Customer ${i}`, email: `c${i}@example.com` });
    }

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        createCustomer(organization.id, { name: `Racer ${i}`, email: `racer${i}@example.com` }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1); // exactly one of the 5 wins the last slot

    const finalCount = await prisma.customer.count({ where: { organizationId: organization.id } });
    expect(finalCount).toBe(limit); // never exceeded, never under-counted
  }, 20000);
});

describe("assertWithinResourceLimit — invoices", () => {
  it("allows creation below the limit and denies at the limit", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme", email: "acme@example.com" });

    for (let i = 0; i < limitMax(PLAN_ENTITLEMENTS.FREE.maxOpenInvoices); i++) {
      await createInvoiceFor(organization.id, customer.id, `INV-${i}`);
    }
    await expect(createInvoiceFor(organization.id, customer.id, "INV-over")).rejects.toThrow(
      EntitlementLimitExceededError,
    );
  }, 20000);

  it("cancelled invoices don't count toward usage", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme", email: "acme@example.com" });
    for (let i = 0; i < limitMax(PLAN_ENTITLEMENTS.FREE.maxOpenInvoices); i++) {
      await createInvoiceFor(organization.id, customer.id, `INV-${i}`);
    }
    const firstInvoice = await prisma.invoice.findFirstOrThrow({ where: { organizationId: organization.id } });
    await cancelInvoice(organization.id, firstInvoice.id);

    await expect(createInvoiceFor(organization.id, customer.id, "INV-fits")).resolves.toBeDefined();
  }, 20000);

  it("concurrent creation cannot trivially exceed the quota", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme", email: "acme@example.com" });
    const limit = limitMax(PLAN_ENTITLEMENTS.FREE.maxOpenInvoices);
    for (let i = 0; i < limit - 1; i++) {
      await createInvoiceFor(organization.id, customer.id, `INV-${i}`);
    }

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => createInvoiceFor(organization.id, customer.id, `INV-race-${i}`)),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const finalCount = await prisma.invoice.count({ where: { organizationId: organization.id, status: "OPEN" } });
    expect(finalCount).toBe(limit);
  }, 20000);
});

describe("tenancy isolation", () => {
  it("one organization's plan/usage cannot affect another organization's entitlements", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");

    await setOrganizationPlan(orgA.id, "PRO");
    for (let i = 0; i < limitMax(PLAN_ENTITLEMENTS.FREE.maxCustomers); i++) {
      await createCustomer(orgB.id, { name: `Customer ${i}`, email: `c${i}@example.com` });
    }

    const entitlementsA = await getOrganizationEntitlements(orgA.id);
    const entitlementsB = await getOrganizationEntitlements(orgB.id);
    expect(entitlementsA.plan).toBe("PRO");
    expect(entitlementsB.plan).toBe("FREE"); // untouched by orgA's upgrade

    // orgB is at its FREE limit; orgA (unlimited customers on PRO) is unaffected.
    await expect(createCustomer(orgB.id, { name: "Over", email: "over@example.com" })).rejects.toThrow(
      EntitlementLimitExceededError,
    );
    await expect(createCustomer(orgA.id, { name: "Fits", email: "fits@example.com" })).resolves.toBeDefined();
  }, 20000);
});

describe("acceptance: fresh org -> FREE quota reached -> denied -> upgrade -> succeeds", () => {
  it("matches the exact flow described in the Phase 11.3 brief", async () => {
    const { organization } = await createTestOrganization();

    const initial = await getOrganizationEntitlements(organization.id);
    expect(initial.plan).toBe("FREE");

    for (let i = 0; i < limitMax(PLAN_ENTITLEMENTS.FREE.maxCustomers); i++) {
      await createCustomer(organization.id, { name: `Customer ${i}`, email: `c${i}@example.com` });
    }

    await expect(
      createCustomer(organization.id, { name: "Denied", email: "denied@example.com" }),
    ).rejects.toThrow(EntitlementLimitExceededError);

    await setOrganizationPlan(organization.id, "STARTER");

    const created = await createCustomer(organization.id, { name: "Now allowed", email: "allowed@example.com" });
    expect(created.name).toBe("Now allowed");

    const usage = await getOrganizationUsage(organization.id);
    const afterEntitlements = await getOrganizationEntitlements(organization.id);
    expect(afterEntitlements.plan).toBe("STARTER");
    expect(usage.customers).toBe(limitMax(PLAN_ENTITLEMENTS.FREE.maxCustomers) + 1);
  }, 20000);
});

describe("assertWithinResourceLimit — unlimited entitlement", () => {
  it("never throws for a resource marked unlimited, regardless of usage", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "PRO"); // unlimited customers

    await prisma.$transaction(async (tx) => {
      await expect(assertWithinResourceLimit(tx, organization.id, "customers")).resolves.toBeUndefined();
    });
  });
});
