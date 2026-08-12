import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { archiveCustomer, createCustomer } from "./customers";
import { createInvoice } from "./invoices";
import { majorToMinor } from "./money";
import { recordPayment } from "./payments";
import { listCustomerActivity, listInvoiceActivity, listOrganizationActivity } from "./activity";
import { createTestOrganization } from "./test-fixtures";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("activity timeline", () => {
  it("records the expected events across a customer/invoice/payment lifecycle", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-0001",
      currency: "USD",
      amountMinor: majorToMinor(1000),
      issueDate: "2026-08-01",
      dueDate: "2026-08-15",
    });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(1000), paidAt: "2026-08-10" });
    await archiveCustomer(organization.id, customer.id);

    const events = await listOrganizationActivity(organization.id, 50);
    const types = events.map((e) => e.type).sort();

    expect(types).toEqual(
      ["CUSTOMER_ARCHIVED", "CUSTOMER_CREATED", "INVOICE_CREATED", "INVOICE_PAID", "PAYMENT_RECORDED"].sort(),
    );
  });

  it("scopes invoice activity to the given invoice", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoiceA = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-A",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2026-08-01",
      dueDate: "2026-08-15",
    });
    const invoiceB = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-B",
      currency: "USD",
      amountMinor: majorToMinor(200),
      issueDate: "2026-08-01",
      dueDate: "2026-08-15",
    });

    const eventsA = await listInvoiceActivity(organization.id, invoiceA.id);
    expect(eventsA.every((e) => e.invoiceId === invoiceA.id)).toBe(true);
    expect(eventsA.some((e) => e.invoiceId === invoiceB.id)).toBe(false);
  });

  it("scopes customer activity to the given customer", async () => {
    const { organization } = await createTestOrganization();
    const customerA = await createCustomer(organization.id, { name: "A" });
    const customerB = await createCustomer(organization.id, { name: "B" });

    const eventsA = await listCustomerActivity(organization.id, customerA.id);
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]?.customerId).toBe(customerA.id);
    void customerB;
  });

  it("does not leak another organization's activity events", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    await createCustomer(orgB.id, { name: "Org B Customer" });

    const eventsA = await listOrganizationActivity(orgA.id, 50);
    expect(eventsA).toHaveLength(0);

    const allEvents = await prisma.activityEvent.findMany();
    expect(allEvents.every((e) => e.organizationId === orgB.id)).toBe(true);
  });
});

describe("listInvoiceActivity / listCustomerActivity — pagination", () => {
  it("bounds and paginates an invoice's activity via cursor, with no duplicates or gaps across pages", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-0001",
      currency: "USD",
      amountMinor: majorToMinor(1000),
      issueDate: "2026-08-01",
      dueDate: "2026-08-15",
    });
    // createInvoice already recorded one INVOICE_CREATED event — add 4 more
    // with distinct, explicit timestamps so cursor ordering is deterministic.
    const base = Date.now();
    for (let i = 0; i < 4; i += 1) {
      await prisma.activityEvent.create({
        data: {
          organizationId: organization.id,
          invoiceId: invoice.id,
          type: "PAYMENT_RECORDED",
          summary: `Manual event ${i}`,
          createdAt: new Date(base + (i + 1) * 1000),
        },
      });
    }

    const firstPage = await listInvoiceActivity(organization.id, invoice.id, { take: 2 });
    expect(firstPage).toHaveLength(2);
    const secondPage = await listInvoiceActivity(organization.id, invoice.id, {
      take: 2,
      cursor: firstPage[1]!.id,
    });
    expect(secondPage).toHaveLength(2);
    const thirdPage = await listInvoiceActivity(organization.id, invoice.id, {
      take: 2,
      cursor: secondPage[1]!.id,
    });
    expect(thirdPage).toHaveLength(1); // exactly the remainder of 5 total events

    const ids = [...firstPage, ...secondPage, ...thirdPage].map((e) => e.id);
    expect(new Set(ids).size).toBe(5); // no duplicates across pages
  });

  it("bounds and paginates a customer's activity via cursor the same way", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const base = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await prisma.activityEvent.create({
        data: {
          organizationId: organization.id,
          customerId: customer.id,
          type: "CUSTOMER_UPDATED",
          summary: `Manual event ${i}`,
          createdAt: new Date(base + (i + 1) * 1000),
        },
      });
    }

    const firstPage = await listCustomerActivity(organization.id, customer.id, { take: 2 });
    expect(firstPage).toHaveLength(2);
    const secondPage = await listCustomerActivity(organization.id, customer.id, {
      take: 2,
      cursor: firstPage[1]!.id,
    });
    // 1 CUSTOMER_CREATED (from createCustomer) + 3 manual = 4 total, so the
    // second page holds exactly the remaining 2.
    expect(secondPage).toHaveLength(2);
    const ids = [...firstPage, ...secondPage].map((e) => e.id);
    expect(new Set(ids).size).toBe(4);
  });

  it("a cursor id belonging to another organization's activity event never leaks that organization's data", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    const customerB = await createCustomer(orgB.id, { name: "B Customer" });
    const eventB = await prisma.activityEvent.findFirstOrThrow({
      where: { organizationId: orgB.id, customerId: customerB.id },
    });

    const result = await listCustomerActivity(orgA.id, customerA.id, { take: 10, cursor: eventB.id });

    expect(result.every((e) => e.organizationId === orgA.id)).toBe(true);
    expect(result.some((e) => e.id === eventB.id)).toBe(false);
  });
});
