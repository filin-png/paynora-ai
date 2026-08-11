import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { cancelInvoice } from "@/server/ar/invoices";
import { recordPayment } from "@/server/ar/payments";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { detectInvoiceOverdueEvents } from "./events";

beforeEach(async () => {
  await resetDatabase();
});

async function createOverdueInvoice(organizationId: string, customerId: string, number = "INV-1") {
  return createInvoice(organizationId, {
    customerId,
    number,
    currency: "USD",
    amountMinor: majorToMinor(100),
    issueDate: "2020-01-01",
    dueDate: "2020-01-15",
  });
}

describe("detectInvoiceOverdueEvents", () => {
  it("creates a BusinessEvent for each overdue invoice", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createOverdueInvoice(organization.id, customer.id);

    const results = await detectInvoiceOverdueEvents(organization.id);

    expect(results).toHaveLength(1);
    expect(results[0].created).toBe(true);
    expect(results[0].event.type).toBe("INVOICE_OVERDUE");
    expect(results[0].event.invoiceId).toBe(invoice.id);
    expect(results[0].event.customerId).toBe(customer.id);
    expect(results[0].event.dedupeKey).toBe(invoice.id);

    const data = results[0].event.data as Record<string, unknown>;
    expect(data.daysOverdue).toBeGreaterThan(0);
    expect(data.outstandingMinor).toBe("10000");
  });

  it("does not create an event for an invoice that isn't overdue yet", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2099-01-01",
      dueDate: "2099-01-15",
    });

    const results = await detectInvoiceOverdueEvents(organization.id);
    expect(results).toHaveLength(0);
  });

  it("does not create an event for a fully paid overdue invoice", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createOverdueInvoice(organization.id, customer.id);
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-01-10" });

    const results = await detectInvoiceOverdueEvents(organization.id);
    expect(results).toHaveLength(0);
  });

  it("does not create an event for a cancelled invoice", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createOverdueInvoice(organization.id, customer.id);
    await cancelInvoice(organization.id, invoice.id);

    const results = await detectInvoiceOverdueEvents(organization.id);
    expect(results).toHaveLength(0);
  });

  it("is idempotent: re-running the detector produces no duplicate event", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await createOverdueInvoice(organization.id, customer.id);

    const first = await detectInvoiceOverdueEvents(organization.id);
    const second = await detectInvoiceOverdueEvents(organization.id);
    const third = await detectInvoiceOverdueEvents(organization.id);

    expect(first).toHaveLength(1);
    expect(first[0].created).toBe(true);
    expect(second[0].created).toBe(false);
    expect(third[0].created).toBe(false);
    expect(second[0].event.id).toBe(first[0].event.id);
    expect(third[0].event.id).toBe(first[0].event.id);

    const count = await prisma.businessEvent.count({ where: { organizationId: organization.id } });
    expect(count).toBe(1);
  });

  it("only detects events for the calling organization (tenant isolation)", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    await createOverdueInvoice(orgA.id, customerA.id);

    const resultsForB = await detectInvoiceOverdueEvents(orgB.id);
    expect(resultsForB).toHaveLength(0);

    const resultsForA = await detectInvoiceOverdueEvents(orgA.id);
    expect(resultsForA).toHaveLength(1);

    const crossTenantCount = await prisma.businessEvent.count({ where: { organizationId: orgB.id } });
    expect(crossTenantCount).toBe(0);
  });

  it("detects one event per overdue invoice when there are several", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await createOverdueInvoice(organization.id, customer.id, "INV-1");
    await createOverdueInvoice(organization.id, customer.id, "INV-2");

    const results = await detectInvoiceOverdueEvents(organization.id);
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.event.invoiceId)).size).toBe(2);
  });
});
