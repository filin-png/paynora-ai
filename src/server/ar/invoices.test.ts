import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createCustomer } from "./customers";
import { computeInvoiceFinancials, createInvoice, getInvoice, listInvoicesWithFinancials } from "./invoices";
import { ArResourceNotFoundError, DuplicateInvoiceNumberError } from "./errors";
import { majorToMinor } from "./money";
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
