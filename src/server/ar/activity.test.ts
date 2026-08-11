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
