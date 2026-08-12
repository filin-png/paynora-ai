import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createCustomer } from "./customers";
import {
  cancelInvoice,
  computeInvoiceFinancials,
  createInvoice,
  getInvoice,
  getPaidMinorForInvoice,
  listInvoicesWithFinancials,
} from "./invoices";
import {
  ArResourceNotFoundError,
  DuplicateInvoiceNumberError,
  InvoiceCancelledError,
  InvoiceHasPaymentsError,
} from "./errors";
import { majorToMinor } from "./money";
import { recordPayment } from "./payments";
import { createTestOrganization } from "./test-fixtures";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

async function setupOrgWithCustomer(namePrefix = "Org") {
  const { organization } = await createTestOrganization(namePrefix);
  const customer = await createCustomer(organization.id, { name: "Acme Corp" });
  return { organization, customer };
}

const validInvoice = {
  number: "INV-0001",
  currency: "USD" as const,
  amountMinor: majorToMinor(1000),
  issueDate: "2026-08-01",
  dueDate: "2026-08-15",
};

describe("createInvoice", () => {
  it("creates an invoice for a customer in the organization", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const invoice = await createInvoice(organization.id, { ...validInvoice, customerId: customer.id });

    expect(invoice.organizationId).toBe(organization.id);
    expect(invoice.customerId).toBe(customer.id);
    expect(invoice.amountMinor).toBe(majorToMinor(1000));
    expect(invoice.status).toBe("OPEN");
  });

  it("records an INVOICE_CREATED activity event", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    const invoice = await createInvoice(organization.id, { ...validInvoice, customerId: customer.id });

    const events = await prisma.activityEvent.findMany({ where: { invoiceId: invoice.id } });
    expect(events.map((e) => e.type)).toContain("INVOICE_CREATED");
  });

  it("rejects a customer belonging to another organization", async () => {
    const { organization: orgA } = await setupOrgWithCustomer("Org A");
    const { customer: customerB } = await setupOrgWithCustomer("Org B");

    await expect(
      createInvoice(orgA.id, { ...validInvoice, customerId: customerB.id }),
    ).rejects.toThrow(ArResourceNotFoundError);
  });

  it("rejects a zero amount", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    await expect(
      createInvoice(organization.id, { ...validInvoice, customerId: customer.id, amountMinor: 0n }),
    ).rejects.toThrow();
  });

  it("rejects a negative amount", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    await expect(
      createInvoice(organization.id, { ...validInvoice, customerId: customer.id, amountMinor: -100n }),
    ).rejects.toThrow();
  });

  it("rejects an unsupported currency", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    await expect(
      createInvoice(organization.id, {
        ...validInvoice,
        customerId: customer.id,
        // @ts-expect-error deliberately invalid for the test
        currency: "GBP",
      }),
    ).rejects.toThrow();
  });

  it("rejects a due date before the issue date", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    await expect(
      createInvoice(organization.id, {
        ...validInvoice,
        customerId: customer.id,
        issueDate: "2026-08-15",
        dueDate: "2026-08-01",
      }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate invoice number within the same organization", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    await createInvoice(organization.id, { ...validInvoice, customerId: customer.id });

    await expect(
      createInvoice(organization.id, { ...validInvoice, customerId: customer.id }),
    ).rejects.toThrow(DuplicateInvoiceNumberError);
  });

  it("allows the same invoice number in two different organizations", async () => {
    const { organization: orgA, customer: customerA } = await setupOrgWithCustomer("Org A");
    const { organization: orgB, customer: customerB } = await setupOrgWithCustomer("Org B");

    await expect(
      createInvoice(orgA.id, { ...validInvoice, customerId: customerA.id }),
    ).resolves.toBeTruthy();
    await expect(
      createInvoice(orgB.id, { ...validInvoice, customerId: customerB.id }),
    ).resolves.toBeTruthy();
  });
});

describe("tenant isolation", () => {
  it("rejects reading an invoice belonging to another organization", async () => {
    const { organization: orgA } = await setupOrgWithCustomer("Org A");
    const { organization: orgB, customer: customerB } = await setupOrgWithCustomer("Org B");
    const invoice = await createInvoice(orgB.id, { ...validInvoice, customerId: customerB.id });

    await expect(getInvoice(orgA.id, invoice.id)).rejects.toThrow(ArResourceNotFoundError);
  });

  it("only lists invoices belonging to the requesting organization", async () => {
    const { organization: orgA, customer: customerA } = await setupOrgWithCustomer("Org A");
    const { organization: orgB, customer: customerB } = await setupOrgWithCustomer("Org B");
    await createInvoice(orgA.id, { ...validInvoice, customerId: customerA.id });
    await createInvoice(orgB.id, { ...validInvoice, customerId: customerB.id });

    const result = await listInvoicesWithFinancials(orgA.id);

    expect(result).toHaveLength(1);
    expect(result[0]?.invoice.organizationId).toBe(orgA.id);
  });
});

describe("listInvoicesWithFinancials — pagination", () => {
  it("omitting take/cursor keeps the previous unbounded behavior (automation/enrollment/events rely on this)", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    for (let i = 0; i < 5; i += 1) {
      await createInvoice(organization.id, { ...validInvoice, number: `INV-000${i}`, customerId: customer.id });
    }

    const result = await listInvoicesWithFinancials(organization.id);

    expect(result).toHaveLength(5);
  });

  it("`take` bounds the result and returns exact-count pages via cursor, in stable issueDate-desc order", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    // Distinct issueDates so ordering is unambiguous before the id tiebreak.
    for (let i = 0; i < 5; i += 1) {
      await createInvoice(organization.id, {
        ...validInvoice,
        number: `INV-000${i}`,
        customerId: customer.id,
        issueDate: `2026-08-0${i + 1}`,
      });
    }

    const firstPage = await listInvoicesWithFinancials(organization.id, "all", { take: 2 });
    expect(firstPage).toHaveLength(2);
    expect(firstPage[0]!.invoice.number).toBe("INV-0004"); // most recently issued first
    expect(firstPage[1]!.invoice.number).toBe("INV-0003");

    const secondPage = await listInvoicesWithFinancials(organization.id, "all", {
      take: 2,
      cursor: firstPage[1]!.invoice.id,
    });
    expect(secondPage).toHaveLength(2);
    expect(secondPage[0]!.invoice.number).toBe("INV-0002");
    expect(secondPage[1]!.invoice.number).toBe("INV-0001");

    const thirdPage = await listInvoicesWithFinancials(organization.id, "all", {
      take: 2,
      cursor: secondPage[1]!.invoice.id,
    });
    expect(thirdPage).toHaveLength(1); // exactly the remainder — no duplicates, no gaps
    expect(thirdPage[0]!.invoice.number).toBe("INV-0000");
  });

  it("paginates correctly together with the customerId filter", async () => {
    const { organization, customer: customerA } = await setupOrgWithCustomer("Org");
    const customerB = await createCustomer(organization.id, { name: "Other Customer" });
    await createInvoice(organization.id, { ...validInvoice, number: "A-1", customerId: customerA.id });
    await createInvoice(organization.id, { ...validInvoice, number: "A-2", customerId: customerA.id });
    await createInvoice(organization.id, { ...validInvoice, number: "B-1", customerId: customerB.id });

    const page = await listInvoicesWithFinancials(organization.id, "all", {
      customerId: customerA.id,
      take: 10,
    });

    expect(page).toHaveLength(2);
    expect(page.every(({ invoice }) => invoice.customerId === customerA.id)).toBe(true);
  });

  it("a cursor id belonging to another organization's invoice never leaks that organization's data", async () => {
    const { organization: orgA, customer: customerA } = await setupOrgWithCustomer("Org A");
    const { organization: orgB, customer: customerB } = await setupOrgWithCustomer("Org B");
    const invoiceB = await createInvoice(orgB.id, { ...validInvoice, number: "B-1", customerId: customerB.id });
    await createInvoice(orgA.id, { ...validInvoice, number: "A-1", customerId: customerA.id });

    // orgA queries using orgB's real invoice id as the pagination cursor —
    // this must never surface orgB's invoice, and must behave exactly
    // like a nonexistent/meaningless cursor, not throw or leak a signal
    // distinguishing "exists in another org" from "doesn't exist at all".
    const result = await listInvoicesWithFinancials(orgA.id, "all", { take: 10, cursor: invoiceB.id });

    expect(result.every(({ invoice }) => invoice.organizationId === orgA.id)).toBe(true);
    expect(result.some(({ invoice }) => invoice.id === invoiceB.id)).toBe(false);
  });
});

describe("cancelInvoice", () => {
  it("cancels an open invoice with no payments", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    const invoice = await createInvoice(organization.id, { ...validInvoice, customerId: customer.id });

    const cancelled = await cancelInvoice(organization.id, invoice.id);

    expect(cancelled.status).toBe("CANCELLED");
  });

  it("records an INVOICE_CANCELLED activity event", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    const invoice = await createInvoice(organization.id, { ...validInvoice, customerId: customer.id });

    await cancelInvoice(organization.id, invoice.id);

    const events = await prisma.activityEvent.findMany({
      where: { invoiceId: invoice.id, type: "INVOICE_CANCELLED" },
    });
    expect(events).toHaveLength(1);
  });

  it("is idempotent — cancelling twice does not duplicate the event or error", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    const invoice = await createInvoice(organization.id, { ...validInvoice, customerId: customer.id });

    await cancelInvoice(organization.id, invoice.id);
    const secondCancel = await cancelInvoice(organization.id, invoice.id);

    expect(secondCancel.status).toBe("CANCELLED");
    const events = await prisma.activityEvent.findMany({
      where: { invoiceId: invoice.id, type: "INVOICE_CANCELLED" },
    });
    expect(events).toHaveLength(1);
  });

  it("rejects cancelling an invoice that already has a recorded payment", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    const invoice = await createInvoice(organization.id, { ...validInvoice, customerId: customer.id });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2026-08-05" });

    await expect(cancelInvoice(organization.id, invoice.id)).rejects.toThrow(InvoiceHasPaymentsError);

    const stillOpen = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(stillOpen.status).toBe("OPEN");
  });

  it("rejects cancelling another organization's invoice", async () => {
    const { organization: orgA } = await setupOrgWithCustomer("Org A");
    const { organization: orgB, customer: customerB } = await setupOrgWithCustomer("Org B");
    const invoice = await createInvoice(orgB.id, { ...validInvoice, customerId: customerB.id });

    await expect(cancelInvoice(orgA.id, invoice.id)).rejects.toThrow(ArResourceNotFoundError);
  });
});

describe("concurrency — cancelInvoice vs. recordPayment", () => {
  it("never leaves a CANCELLED invoice with a payment recorded, whichever operation wins the race", async () => {
    // Both operations lock the same invoice row (lockInvoiceForUpdate) and
    // re-check state only after acquiring that lock, so exactly one of
    // these two concurrent calls must succeed and the other must be
    // rejected — never both, and never a silently inconsistent result.
    const { organization, customer } = await setupOrgWithCustomer();
    const invoice = await createInvoice(organization.id, { ...validInvoice, customerId: customer.id });

    const [cancelResult, paymentResult] = await Promise.allSettled([
      cancelInvoice(organization.id, invoice.id),
      recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(500), paidAt: "2026-08-05" }),
    ]);

    const fulfilledCount = [cancelResult, paymentResult].filter((r) => r.status === "fulfilled").length;
    expect(fulfilledCount).toBe(1);

    const finalInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const paidMinor = await getPaidMinorForInvoice(invoice.id);

    if (finalInvoice.status === "CANCELLED") {
      // Cancellation won: no payment can have landed.
      expect(paidMinor).toBe(0n);
      expect(cancelResult.status).toBe("fulfilled");
      expect(paymentResult.status).toBe("rejected");
      if (paymentResult.status === "rejected") {
        expect(paymentResult.reason).toBeInstanceOf(InvoiceCancelledError);
      }
    } else {
      // The payment won: cancellation must have been rejected, not silently skipped.
      expect(paidMinor).toBe(majorToMinor(500));
      expect(paymentResult.status).toBe("fulfilled");
      expect(cancelResult.status).toBe("rejected");
      if (cancelResult.status === "rejected") {
        expect(cancelResult.reason).toBeInstanceOf(InvoiceHasPaymentsError);
      }
    }
  });
});

describe("computeInvoiceFinancials — lifecycle and dates", () => {
  const baseInvoice = { amountMinor: majorToMinor(1000), status: "OPEN" as const };

  it("is open and not overdue for a future due date", () => {
    const financials = computeInvoiceFinancials(
      { ...baseInvoice, dueDate: new Date("2026-08-20T00:00:00.000Z") },
      0n,
      "2026-08-15",
    );
    expect(financials.isOverdue).toBe(false);
    expect(financials.isPaid).toBe(false);
    expect(financials.isPartiallyPaid).toBe(false);
  });

  it("is not overdue when due today", () => {
    const financials = computeInvoiceFinancials(
      { ...baseInvoice, dueDate: new Date("2026-08-15T00:00:00.000Z") },
      0n,
      "2026-08-15",
    );
    expect(financials.isOverdue).toBe(false);
  });

  it("is overdue the day after the due date, while unpaid", () => {
    const financials = computeInvoiceFinancials(
      { ...baseInvoice, dueDate: new Date("2026-08-14T00:00:00.000Z") },
      0n,
      "2026-08-15",
    );
    expect(financials.isOverdue).toBe(true);
  });

  it("is overdue and partially paid when a partial payment doesn't clear the balance", () => {
    const financials = computeInvoiceFinancials(
      { ...baseInvoice, dueDate: new Date("2026-08-14T00:00:00.000Z") },
      majorToMinor(300),
      "2026-08-15",
    );
    expect(financials.isOverdue).toBe(true);
    expect(financials.isPartiallyPaid).toBe(true);
    expect(financials.outstandingMinor).toBe(majorToMinor(700));
  });

  it("a fully paid invoice is never considered overdue, even past its due date", () => {
    const financials = computeInvoiceFinancials(
      { ...baseInvoice, dueDate: new Date("2026-08-14T00:00:00.000Z") },
      majorToMinor(1000),
      "2026-08-15",
    );
    expect(financials.isPaid).toBe(true);
    expect(financials.isOverdue).toBe(false);
    expect(financials.outstandingMinor).toBe(0n);
  });

  it("a cancelled invoice is never considered overdue", () => {
    const financials = computeInvoiceFinancials(
      { ...baseInvoice, status: "CANCELLED", dueDate: new Date("2026-08-14T00:00:00.000Z") },
      0n,
      "2026-08-15",
    );
    expect(financials.isOverdue).toBe(false);
    expect(financials.isPaid).toBe(false);
  });
});

describe("computeInvoiceFinancials — financial invariant defense-in-depth (P2-2)", () => {
  it("clamps outstandingMinor to zero (never negative) if paidMinor somehow exceeds amountMinor", () => {
    const financials = computeInvoiceFinancials(
      { amountMinor: majorToMinor(500), status: "OPEN" as const, dueDate: new Date("2026-08-20T00:00:00.000Z") },
      majorToMinor(600), // more than amountMinor — should never happen via recordPayment's OverpaymentError, but this is the defense-in-depth backstop
      "2026-08-15",
    );

    expect(financials.outstandingMinor).toBe(0n);
    expect(financials.isPaid).toBe(true); // still correctly treated as fully paid, not "paid" with a negative balance
    expect(financials.isOverdue).toBe(false);
  });

  it("logs the invariant violation for investigation rather than failing silently", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    computeInvoiceFinancials(
      { amountMinor: majorToMinor(500), status: "OPEN" as const, dueDate: new Date("2026-08-20T00:00:00.000Z") },
      majorToMinor(600),
      "2026-08-15",
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("financial invariant violated");
    errorSpy.mockRestore();
  });
});
