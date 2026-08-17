import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createCustomer } from "@/server/ar/customers";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { limitMax, PLAN_ENTITLEMENTS } from "@/server/billing/plans";
import { importCustomers } from "./customers";
import type { NormalizedCustomerRecord } from "./types";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

function record(overrides: Partial<NormalizedCustomerRecord> & { sourceRow: number }): NormalizedCustomerRecord {
  return { name: "", email: "", phone: "", ...overrides };
}

describe("importCustomers", () => {
  it("creates customers from valid records, recording the same activity event manual creation does", async () => {
    const { organization } = await createTestOrganization();

    const summary = await importCustomers(organization.id, [
      record({ sourceRow: 1, name: "Acme Co", email: "acme@example.com", phone: "555-0100" }),
      record({ sourceRow: 2, name: "Beta LLC", email: "beta@example.com" }),
    ]);

    expect(summary.totalRows).toBe(2);
    expect(summary.created).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);

    const customers = await prisma.customer.findMany({ where: { organizationId: organization.id }, orderBy: { name: "asc" } });
    expect(customers).toHaveLength(2);
    expect(customers[0]!.name).toBe("Acme Co");
    expect(customers[0]!.email).toBe("acme@example.com");
    expect(customers[1]!.name).toBe("Beta LLC");
    expect(customers[1]!.email).toBe("beta@example.com");

    const events = await prisma.activityEvent.findMany({ where: { organizationId: organization.id, type: "CUSTOMER_CREATED" } });
    expect(events).toHaveLength(2);
  });

  it("rejects a row with a missing (blank) email", async () => {
    const { organization } = await createTestOrganization();

    const summary = await importCustomers(organization.id, [record({ sourceRow: 1, name: "Acme Co", email: "" })]);

    expect(summary.created).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.rows[0]!.status).toBe("failed");
    expect(summary.rows[0]!.field).toBe("email");
    expect(summary.rows[0]!.message).toMatch(/missing email/i);

    const customers = await prisma.customer.findMany({ where: { organizationId: organization.id } });
    expect(customers).toHaveLength(0);
  });

  it("rejects a row with an invalid email via the same validation the manual form uses", async () => {
    const { organization } = await createTestOrganization();

    const summary = await importCustomers(organization.id, [record({ sourceRow: 1, name: "Acme", email: "not-an-email" })]);

    expect(summary.created).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.rows[0]!.status).toBe("failed");
    expect(summary.rows[0]!.field).toBe("email");
  });

  it("rejects a row with a missing name", async () => {
    const { organization } = await createTestOrganization();

    const summary = await importCustomers(organization.id, [record({ sourceRow: 1, name: "", email: "acme@example.com" })]);

    expect(summary.failed).toBe(1);
    expect(summary.rows[0]!.field).toBe("name");
  });

  it("skips a second row in the same file with the same email — created once, not duplicated", async () => {
    const { organization } = await createTestOrganization();

    const summary = await importCustomers(organization.id, [
      record({ sourceRow: 1, name: "Acme Co", email: "acme@example.com" }),
      record({ sourceRow: 2, name: "Acme Co (dup)", email: "ACME@Example.com" }), // case-insensitive match
    ]);

    expect(summary.created).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.rows[1]!.status).toBe("skipped");

    const customers = await prisma.customer.findMany({ where: { organizationId: organization.id } });
    expect(customers).toHaveLength(1);
  });

  it("skips a row whose email already belongs to an existing customer, without modifying the existing customer", async () => {
    const { organization } = await createTestOrganization();
    const existing = await createCustomer(organization.id, { name: "Original Name", email: "acme@example.com" });

    const summary = await importCustomers(organization.id, [
      record({ sourceRow: 1, name: "Different Name From CSV", email: "acme@example.com" }),
    ]);

    expect(summary.created).toBe(0);
    expect(summary.skipped).toBe(1);

    const reloaded = await prisma.customer.findUniqueOrThrow({ where: { id: existing.id } });
    expect(reloaded.name).toBe("Original Name"); // never overwritten by the import
    const customers = await prisma.customer.findMany({ where: { organizationId: organization.id } });
    expect(customers).toHaveLength(1);
  });

  it("importing the exact same file twice is idempotent — the second run only skips", async () => {
    const { organization } = await createTestOrganization();
    const records = [record({ sourceRow: 1, name: "Acme Co", email: "acme@example.com" })];

    const first = await importCustomers(organization.id, records);
    const second = await importCustomers(organization.id, records);

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    const customers = await prisma.customer.findMany({ where: { organizationId: organization.id } });
    expect(customers).toHaveLength(1);
  });

  it("reports a malformed source row as failed without crashing the rest of the import", async () => {
    const { organization } = await createTestOrganization();

    const summary = await importCustomers(organization.id, [
      record({ sourceRow: 1, name: "Acme Co", email: "acme@example.com" }),
      record({ sourceRow: 2, sourceError: "too many fields" }),
      record({ sourceRow: 3, name: "Beta LLC", email: "beta@example.com" }),
    ]);

    expect(summary.created).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.rows[1]!.status).toBe("failed");
    expect(summary.rows[1]!.message).toContain("too many fields");
  });

  it("tenant isolation: an email already used by another organization's customer does not block this organization's import", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    await createCustomer(orgB.id, { name: "Org B's Acme", email: "shared@example.com" });

    const summary = await importCustomers(orgA.id, [record({ sourceRow: 1, name: "Org A's Acme", email: "shared@example.com" })]);

    expect(summary.created).toBe(1); // not skipped — the existing match belongs to a different org
    const customersA = await prisma.customer.findMany({ where: { organizationId: orgA.id } });
    expect(customersA).toHaveLength(1);
    expect(customersA[0]!.name).toBe("Org A's Acme");
  });
});

// --- Phase 11.3 (brief section 7): bulk import must never bypass the
// organization's plan customer quota. -------------------------------------
describe("importCustomers — plan quota safety", () => {
  const FREE_LIMIT = limitMax(PLAN_ENTITLEMENTS.FREE.maxCustomers);

  it("only imports as many new customers as remain under the quota, never exceeding it", async () => {
    const { organization } = await createTestOrganization();
    const room = 5;
    for (let i = 0; i < FREE_LIMIT - room; i++) {
      await createCustomer(organization.id, { name: `Existing ${i}`, email: `existing${i}@example.com` });
    }

    const filled = Array.from({ length: room }, (_, i) =>
      record({ sourceRow: i + 1, name: `New ${i}`, email: `new${i}@example.com` }),
    );
    const overflow = Array.from({ length: 5 }, (_, i) =>
      record({ sourceRow: room + i + 1, name: `Overflow ${i}`, email: `overflow${i}@example.com` }),
    );

    const summary = await importCustomers(organization.id, [...filled, ...overflow]);

    expect(summary.created).toBe(room);
    expect(summary.failed).toBe(5);
    for (const row of summary.rows.slice(room)) {
      expect(row.status).toBe("failed");
      expect(row.message).toMatch(/plan/i);
    }

    const finalCount = await prisma.customer.count({ where: { organizationId: organization.id } });
    expect(finalCount).toBe(FREE_LIMIT); // exactly at the limit, never over
  }, 20000);

  it("a duplicate (already-existing) row never consumes quota — a genuinely new row still correctly fails once at the limit", async () => {
    const { organization } = await createTestOrganization();
    for (let i = 0; i < FREE_LIMIT - 1; i++) {
      await createCustomer(organization.id, { name: `Existing ${i}`, email: `existing${i}@example.com` });
    }
    await createCustomer(organization.id, { name: "Last slot", email: "lastslot@example.com" });
    // Organization is now exactly at its limit.

    const summary = await importCustomers(organization.id, [
      record({ sourceRow: 1, name: "Dup of existing", email: "lastslot@example.com" }),
      record({ sourceRow: 2, name: "Genuinely new", email: "brandnew@example.com" }),
    ]);

    expect(summary.rows[0]!.status).toBe("skipped"); // already exists — no quota consumed, no failure
    // Correctly fails on quota (the org's real usage, not inflated by the
    // duplicate row above) rather than being let through.
    expect(summary.rows[1]!.status).toBe("failed");
    expect(summary.rows[1]!.message).toMatch(/plan/i);

    const finalCount = await prisma.customer.count({ where: { organizationId: organization.id } });
    expect(finalCount).toBe(FREE_LIMIT); // unchanged
  }, 20000);

  it("re-importing the same file after hitting quota remains idempotent for the rows that already succeeded", async () => {
    const { organization } = await createTestOrganization();
    const records = Array.from({ length: FREE_LIMIT + 3 }, (_, i) =>
      record({ sourceRow: i + 1, name: `Customer ${i}`, email: `c${i}@example.com` }),
    );

    const first = await importCustomers(organization.id, records);
    expect(first.created).toBe(FREE_LIMIT);
    expect(first.failed).toBe(3);

    const second = await importCustomers(organization.id, records);
    // Every row that was created the first time is now a duplicate-skip;
    // none of the previously-quota-failed rows can succeed either, since
    // usage is still at the limit.
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(FREE_LIMIT);
    expect(second.failed).toBe(3);

    const finalCount = await prisma.customer.count({ where: { organizationId: organization.id } });
    expect(finalCount).toBe(FREE_LIMIT);
  }, 20000);
});
