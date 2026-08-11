import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { archiveCustomer, createCustomer, getCustomer, listCustomers, updateCustomer } from "./customers";
import { ArResourceNotFoundError } from "./errors";
import { createTestOrganization } from "./test-fixtures";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("createCustomer", () => {
  it("creates a customer for the organization", async () => {
    const { organization } = await createTestOrganization();

    const customer = await createCustomer(organization.id, { name: "Acme Corp", email: "billing@acme.test" });

    expect(customer.organizationId).toBe(organization.id);
    expect(customer.name).toBe("Acme Corp");
    expect(customer.archivedAt).toBeNull();
  });

  it("records a CUSTOMER_CREATED activity event", async () => {
    const { organization } = await createTestOrganization();

    const customer = await createCustomer(organization.id, { name: "Acme Corp" });

    const events = await prisma.activityEvent.findMany({ where: { customerId: customer.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("CUSTOMER_CREATED");
  });

  it("rejects an empty name", async () => {
    const { organization } = await createTestOrganization();
    await expect(createCustomer(organization.id, { name: "" })).rejects.toThrow();
  });

  it("rejects an invalid email", async () => {
    const { organization } = await createTestOrganization();
    await expect(
      createCustomer(organization.id, { name: "Acme", email: "not-an-email" }),
    ).rejects.toThrow();
  });
});

describe("updateCustomer", () => {
  it("updates customer fields and records an activity event", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Old Name" });

    const updated = await updateCustomer(organization.id, customer.id, { name: "New Name" });

    expect(updated.name).toBe("New Name");
    const events = await prisma.activityEvent.findMany({
      where: { customerId: customer.id, type: "CUSTOMER_UPDATED" },
    });
    expect(events).toHaveLength(1);
  });

  it("rejects updating a customer belonging to another organization", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customer = await createCustomer(orgB.id, { name: "Org B Customer" });

    await expect(
      updateCustomer(orgA.id, customer.id, { name: "Hijacked" }),
    ).rejects.toThrow(ArResourceNotFoundError);
  });
});

describe("archiveCustomer", () => {
  it("sets archivedAt and records an activity event", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });

    const archived = await archiveCustomer(organization.id, customer.id);

    expect(archived.archivedAt).not.toBeNull();
    const events = await prisma.activityEvent.findMany({
      where: { customerId: customer.id, type: "CUSTOMER_ARCHIVED" },
    });
    expect(events).toHaveLength(1);
  });

  it("is idempotent — archiving twice does not duplicate the event", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });

    await archiveCustomer(organization.id, customer.id);
    await archiveCustomer(organization.id, customer.id);

    const events = await prisma.activityEvent.findMany({
      where: { customerId: customer.id, type: "CUSTOMER_ARCHIVED" },
    });
    expect(events).toHaveLength(1);
  });

  it("excludes archived customers from listCustomers by default", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await archiveCustomer(organization.id, customer.id);

    const active = await listCustomers(organization.id);
    const withArchived = await listCustomers(organization.id, { includeArchived: true });

    expect(active).toHaveLength(0);
    expect(withArchived).toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  it("rejects reading a customer that belongs to another organization", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customer = await createCustomer(orgB.id, { name: "Org B Customer" });

    await expect(getCustomer(orgA.id, customer.id)).rejects.toThrow(ArResourceNotFoundError);
  });

  it("only lists customers belonging to the requesting organization", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    await createCustomer(orgA.id, { name: "Org A Customer" });
    await createCustomer(orgB.id, { name: "Org B Customer" });

    const result = await listCustomers(orgA.id);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Org A Customer");
  });
});
