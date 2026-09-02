import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { cancelInvoice } from "@/server/ar/invoices";
import { recordPayment } from "@/server/ar/payments";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import {
  detectCustomerBehaviorDeterioratedEvents,
  detectInvoiceOverdueEvents,
  detectInvoiceRiskEscalationEvents,
  detectPaymentReceivedEvents,
} from "./events";

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

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function createInvoiceDueDaysAgo(
  organizationId: string,
  customerId: string,
  daysOverdue: number,
  number = "INV-1",
) {
  return createInvoice(organizationId, {
    customerId,
    number,
    currency: "USD",
    amountMinor: majorToMinor(100),
    issueDate: daysAgo(daysOverdue + 30),
    dueDate: daysAgo(daysOverdue),
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

describe("detectPaymentReceivedEvents", () => {
  it("creates one PAYMENT_RECEIVED event per recorded payment", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createOverdueInvoice(organization.id, customer.id);
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-01-10" });

    const results = await detectPaymentReceivedEvents(organization.id);

    expect(results).toHaveLength(1);
    expect(results[0].created).toBe(true);
    expect(results[0].event.type).toBe("PAYMENT_RECEIVED");
    expect(results[0].event.invoiceId).toBe(invoice.id);
    const data = results[0].event.data as Record<string, unknown>;
    expect(data.amountMinor).toBe("10000");
  });

  it("is idempotent: re-running never duplicates the event for the same payment", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createOverdueInvoice(organization.id, customer.id);
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-01-10" });

    const first = await detectPaymentReceivedEvents(organization.id);
    const second = await detectPaymentReceivedEvents(organization.id);

    expect(first[0].created).toBe(true);
    expect(second[0].created).toBe(false);
    expect(second[0].event.id).toBe(first[0].event.id);
    const count = await prisma.businessEvent.count({ where: { organizationId: organization.id, type: "PAYMENT_RECEIVED" } });
    expect(count).toBe(1);
  });

  it("only detects payments for the calling organization (tenant isolation)", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    const invoiceA = await createOverdueInvoice(orgA.id, customerA.id);
    await recordPayment(orgA.id, invoiceA.id, { amountMinor: majorToMinor(100), paidAt: "2020-01-10" });

    const resultsForB = await detectPaymentReceivedEvents(orgB.id);
    expect(resultsForB).toHaveLength(0);
  });

  it("does not detect a payment recorded outside the lookback window", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createOverdueInvoice(organization.id, customer.id);
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-01-10" });

    // A negative lookback means "since a time in the future" — no payment (created just now) qualifies.
    const results = await detectPaymentReceivedEvents(organization.id, -1);
    expect(results).toHaveLength(0);
  });
});

describe("detectInvoiceRiskEscalationEvents", () => {
  it("creates a HIGH bucket event for an invoice overdue 30+ days", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createInvoiceDueDaysAgo(organization.id, customer.id, 45);

    const results = await detectInvoiceRiskEscalationEvents(organization.id);

    expect(results).toHaveLength(1);
    expect(results[0].event.dedupeKey).toBe(`${invoice.id}:HIGH`);
    const data = results[0].event.data as Record<string, unknown>;
    expect(data.bucket).toBe("HIGH");
  });

  it("creates a MEDIUM bucket event for an invoice overdue between 7 and 29 days", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createInvoiceDueDaysAgo(organization.id, customer.id, 10);

    const results = await detectInvoiceRiskEscalationEvents(organization.id);

    expect(results).toHaveLength(1);
    expect(results[0].event.dedupeKey).toBe(`${invoice.id}:MEDIUM`);
  });

  it("does not create an event for an invoice overdue fewer than 7 days (LOW)", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await createInvoiceDueDaysAgo(organization.id, customer.id, 2);

    const results = await detectInvoiceRiskEscalationEvents(organization.id);
    expect(results).toHaveLength(0);
  });

  it("is idempotent per bucket: re-running at the same bucket never duplicates", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await createInvoiceDueDaysAgo(organization.id, customer.id, 45);

    const first = await detectInvoiceRiskEscalationEvents(organization.id);
    const second = await detectInvoiceRiskEscalationEvents(organization.id);

    expect(first[0].created).toBe(true);
    expect(second[0].created).toBe(false);
    const count = await prisma.businessEvent.count({
      where: { organizationId: organization.id, type: "INVOICE_RISK_ESCALATED" },
    });
    expect(count).toBe(1);
  });

  it("only escalates invoices for the calling organization (tenant isolation)", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    await createInvoiceDueDaysAgo(orgA.id, customerA.id, 45);

    const resultsForB = await detectInvoiceRiskEscalationEvents(orgB.id);
    expect(resultsForB).toHaveLength(0);
  });
});

describe("detectCustomerBehaviorDeterioratedEvents", () => {
  it("does not fire for a customer with no payment history (insufficient history)", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await createOverdueInvoice(organization.id, customer.id);

    const results = await detectCustomerBehaviorDeterioratedEvents(organization.id);
    expect(results).toHaveLength(0);
  });

  it("fires when a customer's recent payment delay has deteriorated versus their prior history", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });

    // Previous window: paid close to on time (small delay).
    for (let i = 0; i < 3; i += 1) {
      const invoice = await createInvoice(organization.id, {
        customerId: customer.id,
        number: `PREV-${i}`,
        currency: "USD",
        amountMinor: majorToMinor(100),
        issueDate: "2020-01-01",
        dueDate: "2020-02-01",
      });
      await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-02-02" });
    }
    // Recent window: paid very late.
    for (let i = 0; i < 3; i += 1) {
      const invoice = await createInvoice(organization.id, {
        customerId: customer.id,
        number: `RECENT-${i}`,
        currency: "USD",
        amountMinor: majorToMinor(100),
        issueDate: "2020-03-01",
        dueDate: "2020-04-01",
      });
      await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-04-20" });
    }

    const results = await detectCustomerBehaviorDeterioratedEvents(organization.id);

    expect(results).toHaveLength(1);
    expect(results[0].event.customerId).toBe(customer.id);
    const data = results[0].event.data as Record<string, unknown>;
    expect(data.deltaDays).toBeGreaterThan(0);
  });

  it("is idempotent within the same calendar week", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    for (let i = 0; i < 3; i += 1) {
      const invoice = await createInvoice(organization.id, {
        customerId: customer.id,
        number: `PREV-${i}`,
        currency: "USD",
        amountMinor: majorToMinor(100),
        issueDate: "2020-01-01",
        dueDate: "2020-02-01",
      });
      await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-02-02" });
    }
    for (let i = 0; i < 3; i += 1) {
      const invoice = await createInvoice(organization.id, {
        customerId: customer.id,
        number: `RECENT-${i}`,
        currency: "USD",
        amountMinor: majorToMinor(100),
        issueDate: "2020-03-01",
        dueDate: "2020-04-01",
      });
      await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-04-20" });
    }

    const first = await detectCustomerBehaviorDeterioratedEvents(organization.id);
    const second = await detectCustomerBehaviorDeterioratedEvents(organization.id);

    expect(first[0].created).toBe(true);
    expect(second[0].created).toBe(false);
    const count = await prisma.businessEvent.count({
      where: { organizationId: organization.id, type: "CUSTOMER_PAYMENT_BEHAVIOR_DETERIORATED" },
    });
    expect(count).toBe(1);
  });

  it("only detects deterioration for the calling organization (tenant isolation)", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    for (let i = 0; i < 3; i += 1) {
      const invoice = await createInvoice(orgA.id, {
        customerId: customerA.id,
        number: `PREV-${i}`,
        currency: "USD",
        amountMinor: majorToMinor(100),
        issueDate: "2020-01-01",
        dueDate: "2020-02-01",
      });
      await recordPayment(orgA.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-02-02" });
    }
    for (let i = 0; i < 3; i += 1) {
      const invoice = await createInvoice(orgA.id, {
        customerId: customerA.id,
        number: `RECENT-${i}`,
        currency: "USD",
        amountMinor: majorToMinor(100),
        issueDate: "2020-03-01",
        dueDate: "2020-04-01",
      });
      await recordPayment(orgA.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-04-20" });
    }

    const resultsForB = await detectCustomerBehaviorDeterioratedEvents(orgB.id);
    expect(resultsForB).toHaveLength(0);
  });
});
