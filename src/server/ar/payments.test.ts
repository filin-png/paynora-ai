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

// --- Phase 9: payment idempotency ----------------------------------------
// docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-1. A real, persisted
// idempotency key — not a frontend-disable-the-button workaround — proven
// under real Postgres concurrency, not just sequential calls.

describe("recordPayment — idempotency", () => {
  it("A retry with the same key after the first request committed returns the original payment, not a new one", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    const key = "retry-key-1";

    const first = await recordPayment(organization.id, invoice.id, {
      amountMinor: majorToMinor(300),
      paidAt: "2026-08-10",
      idempotencyKey: key,
    });
    const retried = await recordPayment(organization.id, invoice.id, {
      amountMinor: majorToMinor(300),
      paidAt: "2026-08-10",
      idempotencyKey: key,
    });

    expect(retried.id).toBe(first.id);
    const payments = await listPaymentsForInvoice(organization.id, invoice.id);
    expect(payments).toHaveLength(1);

    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.outstandingMinor).toBe(majorToMinor(700)); // charged once, not twice
  });

  it("simulates 'the first request committed but the response was lost': a client resubmitting the same key never double-charges", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    const key = "lost-response-key";

    // The client's perspective: it sent a request, got no confirmed
    // response (timeout, dropped connection, ...), and — not knowing
    // whether the server actually processed it — resubmits with the same
    // key it generated originally. From the server's side this looks
    // exactly like two independent calls with the same key.
    const first = await recordPayment(organization.id, invoice.id, {
      amountMinor: majorToMinor(1000),
      paidAt: "2026-08-10",
      idempotencyKey: key,
    });
    const resubmitted = await recordPayment(organization.id, invoice.id, {
      amountMinor: majorToMinor(1000),
      paidAt: "2026-08-10",
      idempotencyKey: key,
    });

    expect(resubmitted.id).toBe(first.id);
    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.isPaid).toBe(true);
    expect(financials.outstandingMinor).toBe(0n); // not overpaid/negative from a phantom second charge
  });

  it("A + A: two concurrent requests with the SAME key never create two payments (real Postgres concurrency)", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    const key = "concurrent-same-key";

    const results = await Promise.allSettled([
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(400), paidAt: "2026-08-10", idempotencyKey: key }),
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(400), paidAt: "2026-08-10", idempotencyKey: key }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const ids = new Set(
      results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof recordPayment>>>).value.id),
    );
    expect(ids.size).toBe(1); // both calls resolved to the SAME payment row

    const payments = await listPaymentsForInvoice(organization.id, invoice.id);
    expect(payments).toHaveLength(1);
    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.outstandingMinor).toBe(majorToMinor(600)); // charged once, not twice
  });

  it("A + B: two concurrent requests with DIFFERENT keys are two real, independent payments", async () => {
    const { organization, invoice } = await setupInvoice(1000);

    const results = await Promise.allSettled([
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(300), paidAt: "2026-08-10", idempotencyKey: "key-a" }),
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(300), paidAt: "2026-08-10", idempotencyKey: "key-b" }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const payments = await listPaymentsForInvoice(organization.id, invoice.id);
    expect(payments).toHaveLength(2); // genuinely two separate payments, not deduplicated

    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.outstandingMinor).toBe(majorToMinor(400));
  });

  it("a duplicate whose combined value still fits the outstanding balance is only ever recorded once per key", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    // A single 300 payment, retried 3 times with the same key — each
    // individually "fits" within the 1000 balance, which is exactly why
    // this case is dangerous without idempotency (naive overpayment
    // protection alone would happily allow all three).
    const key = "fits-balance-key";
    for (let i = 0; i < 3; i++) {
      await recordPayment(organization.id, invoice.id, {
        amountMinor: majorToMinor(300),
        paidAt: "2026-08-10",
        idempotencyKey: key,
      });
    }

    const payments = await listPaymentsForInvoice(organization.id, invoice.id);
    expect(payments).toHaveLength(1);
    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.outstandingMinor).toBe(majorToMinor(700));
  });

  it("preserves overpayment protection: a genuinely new key that would overpay is still rejected", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    await recordPayment(organization.id, invoice.id, {
      amountMinor: majorToMinor(700),
      paidAt: "2026-08-05",
      idempotencyKey: "key-1",
    });

    await expect(
      recordPayment(organization.id, invoice.id, {
        amountMinor: majorToMinor(400),
        paidAt: "2026-08-10",
        idempotencyKey: "key-2", // a different, real second payment
      }),
    ).rejects.toThrow(OverpaymentError);
  });

  it("cancel/payment race: a retried key on an invoice cancelled between the original attempt and the retry still respects cancellation if no payment ever committed", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    // The first attempt never actually creates a Payment row (rejected as
    // an overpayment) — a genuinely fresh retry with the same key after
    // the invoice is cancelled must still be blocked, not silently
    // treated as "already handled".
    await expect(
      recordPayment(organization.id, invoice.id, {
        amountMinor: majorToMinor(1000.01),
        paidAt: "2026-08-10",
        idempotencyKey: "never-committed-key",
      }),
    ).rejects.toThrow(OverpaymentError);

    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED" } });

    await expect(
      recordPayment(organization.id, invoice.id, {
        amountMinor: majorToMinor(1000.01),
        paidAt: "2026-08-10",
        idempotencyKey: "never-committed-key",
      }),
    ).rejects.toThrow(InvoiceCancelledError);
  });

  it("tenant isolation is preserved for idempotency lookups: the same key string in a different organization's invoice is unrelated", async () => {
    const { organization: orgA, invoice: invoiceA } = await setupInvoice(1000, "Org A");
    const { organization: orgB, invoice: invoiceB } = await setupInvoice(1000, "Org B");
    const sharedKey = "same-literal-key";

    const paymentA = await recordPayment(orgA.id, invoiceA.id, {
      amountMinor: majorToMinor(300),
      paidAt: "2026-08-10",
      idempotencyKey: sharedKey,
    });
    const paymentB = await recordPayment(orgB.id, invoiceB.id, {
      amountMinor: majorToMinor(300),
      paidAt: "2026-08-10",
      idempotencyKey: sharedKey,
    });

    expect(paymentA.id).not.toBe(paymentB.id);
    expect(await listPaymentsForInvoice(orgA.id, invoiceA.id)).toHaveLength(1);
    expect(await listPaymentsForInvoice(orgB.id, invoiceB.id)).toHaveLength(1);
  });

  it("without an explicit key, each call still gets its own random one and is never accidentally deduplicated against another call", async () => {
    const { organization, invoice } = await setupInvoice(1000);
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(300), paidAt: "2026-08-05" });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(300), paidAt: "2026-08-10" });

    const payments = await listPaymentsForInvoice(organization.id, invoice.id);
    expect(payments).toHaveLength(2);
  });
});
