import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createCustomer } from "@/server/ar/customers";
import { createTestOrganization } from "@/server/ar/test-fixtures";
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
      record({ sourceRow: 2, name: "Beta LLC" }),
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
    expect(customers[1]!.email).toBeNull();

    const events = await prisma.activityEvent.findMany({ where: { organizationId: organization.id, type: "CUSTOMER_CREATED" } });
    expect(events).toHaveLength(2);
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

    const summary = await importCustomers(organization.id, [record({ sourceRow: 1, name: "" })]);

    expect(summary.failed).toBe(1);
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
      record({ sourceRow: 3, name: "Beta LLC" }),
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
