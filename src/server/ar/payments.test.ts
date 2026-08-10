import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createCustomer } from "./customers";
import { createInvoice, getInvoiceWithFinancials } from "./invoices";
import { ArResourceNotFoundError, InvoiceCancelledError, OverpaymentError } from "./errors";
import { majorToMinor } from "./money";
import { listPaymentsForInvoice, recordPayment } from "./payments";
import { createTestOrganization } from "./test-fixtures";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

async function setupInvoice(amountMajor: number, namePrefix = "Org") {
  const { organization } = await createTestOrganization(namePrefix);
  const customer = await createCustomer(organization.id, { name: "Acme Corp" });
  const invoice = await createInvoice(organization.id, {
    customerId: customer.id,
    number: "INV-0001",
    currency: "USD",
    amountMinor: majorToMinor(amountMajor),
    issueDate: "2026-08-01",
    dueDate: "2026-08-15",
  });
  return { organization, customer, invoice };
}

describe("recordPayment", () => {
  it("records a full payment and marks the invoice paid", async () => {
    const { organization, invoice } = await setupInvoice(1000);

    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(1000), paidAt: "2026-08-10" });

    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.outstandingMinor).toBe(0n);
    expect(financials.isPaid).toBe(true);
  });

  it("records a partial payment, leaving the correct outstanding balance", async () => {
    const { organization, invoice } = await setupInvoice(1000);

    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(300), paidAt: "2026-08-10" });

    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.outstandingMinor).toBe(majorToMinor(700));
    expect(financials.isPartiallyPaid).toBe(true);
    expect(financials.isPaid).toBe(false);
  });

  it("accumulates multiple partial payments to zero outstanding", async () => {
    const { organization, invoice } = await setupInvoice(1000);

    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(300), paidAt: "2026-08-05" });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(700), paidAt: "2026-08-10" });

    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.outstandingMinor).toBe(0n);
    expect(financials.isPaid).toBe(true);

    const payments = await listPaymentsForInvoice(organization.id, invoice.id);
    expect(payments).toHaveLength(2);
  });

  it("rejects a zero-amount payment", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    await expect(
      recordPayment(organization.id, invoice.id, { amountMinor: 0n, paidAt: "2026-08-10" }),
    ).rejects.toThrow();
  });

  it("rejects a negative-amount payment", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    await expect(
      recordPayment(organization.id, invoice.id, { amountMinor: -100n, paidAt: "2026-08-10" }),
    ).rejects.toThrow();
  });

  it("rejects a payment that would exceed the outstanding balance", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    await expect(
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(1000.01), paidAt: "2026-08-10" }),
    ).rejects.toThrow(OverpaymentError);
  });

  it("rejects a second payment that would overpay after a partial payment", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(700), paidAt: "2026-08-05" });

    await expect(
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(300.01), paidAt: "2026-08-10" }),
    ).rejects.toThrow(OverpaymentError);

    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.outstandingMinor).toBe(majorToMinor(300));
  });

  it("records a PAYMENT_RECORDED and INVOICE_PAID activity event on the final payment", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(1000), paidAt: "2026-08-10" });

    const events = await prisma.activityEvent.findMany({ where: { invoiceId: invoice.id } });
    const types = events.map((e) => e.type);
    expect(types).toContain("PAYMENT_RECORDED");
    expect(types).toContain("INVOICE_PAID");
  });

  it("does not record INVOICE_PAID on a partial payment", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(300), paidAt: "2026-08-10" });

    const events = await prisma.activityEvent.findMany({ where: { invoiceId: invoice.id, type: "INVOICE_PAID" } });
    expect(events).toHaveLength(0);
  });

  it("rejects a payment against another organization's invoice", async () => {
    const { organization: orgA } = await setupInvoice(1000, "Org A");
    const { invoice: invoiceB } = await setupInvoice(1000, "Org B");

    await expect(
      recordPayment(orgA.id, invoiceB.id, { amountMinor: majorToMinor(100), paidAt: "2026-08-10" }),
    ).rejects.toThrow(ArResourceNotFoundError);
  });

  it("rejects a payment against a cancelled invoice", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED" } });

    await expect(
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2026-08-10" }),
    ).rejects.toThrow(InvoiceCancelledError);
  });

  it("handles an amount well beyond the old Int32 minor-unit ceiling", async () => {
    const { organization, invoice } = await setupInvoice(50_000_000); // 50M major units

    await recordPayment(organization.id, invoice.id, {
      amountMinor: majorToMinor(50_000_000),
      paidAt: "2026-08-10",
    });

    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.isPaid).toBe(true);
    expect(financials.outstandingMinor).toBe(0n);
  });
});

describe("concurrency — overpayment protection", () => {
  it("cannot be overpaid by two payments recorded at the same time", async () => {
    // Invoice for 1000; two concurrent payments of 700 each. Individually
    // each fits (700 < 1000), but together they'd overpay by 400. The
    // SELECT ... FOR UPDATE lock in recordPayment must serialize these so
    // exactly one succeeds.
    const { organization, invoice } = await setupInvoice(1000);

    const results = await Promise.allSettled([
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(700), paidAt: "2026-08-10" }),
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(700), paidAt: "2026-08-10" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OverpaymentError);

    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.outstandingMinor).toBe(majorToMinor(300));
    expect(financials.outstandingMinor >= 0n).toBe(true);

    const payments = await listPaymentsForInvoice(organization.id, invoice.id);
    expect(payments).toHaveLength(1);
  });

  it("allows two concurrent payments that together exactly clear the balance", async () => {
    const { organization, invoice } = await setupInvoice(1000);

    const results = await Promise.allSettled([
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(500), paidAt: "2026-08-10" }),
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(500), paidAt: "2026-08-10" }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.outstandingMinor).toBe(0n);
    expect(financials.isPaid).toBe(true);
  });
});
