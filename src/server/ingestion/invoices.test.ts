import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createCustomer } from "@/server/ar/customers";
import { createInvoice, getInvoiceWithFinancials } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { runAutomationTick } from "@/server/collections/engine";
import { createAutomationReadyOrg } from "@/server/collections/test-fixtures";
import { importCustomers } from "./customers";
import { importInvoices } from "./invoices";
import type { NormalizedInvoiceRecord } from "./types";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

function record(overrides: Partial<NormalizedInvoiceRecord> & { sourceRow: number }): NormalizedInvoiceRecord {
  return {
    invoiceNumber: "",
    customerEmail: "",
    amount: "",
    currency: "USD",
    issueDate: "2026-01-01",
    dueDate: "2026-01-15",
    ...overrides,
  };
}

async function setupOrgWithCustomer(email = "acme@example.com") {
  const { organization } = await createTestOrganization();
  const customer = await createCustomer(organization.id, { name: "Acme Co", email });
  return { organization, customer };
}

describe("importInvoices — money conversion", () => {
  it.each([
    ["100", 10000n],
    ["100.25", 10025n],
    ["0.01", 1n],
    ["1500.00", 150000n],
  ])("converts decimal string %s to %s minor units via exact arithmetic, never a float", async (amount, expectedMinor) => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount }),
    ]);

    expect(summary.created).toBe(1);
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { organizationId: organization.id } });
    expect(invoice.amountMinor).toBe(expectedMinor);
  });

  it("rejects a malformed amount", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "not a number" }),
    ]);

    expect(summary.failed).toBe(1);
    expect(summary.rows[0]!.field).toBe("amount");
  });

  it("rejects an amount with more than 2 decimal places", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "100.999" }),
    ]);

    expect(summary.failed).toBe(1);
  });

  it("rejects a negative amount", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "-100" }),
    ]);

    expect(summary.failed).toBe(1);
  });

  it("rejects a zero amount", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "0" }),
    ]);

    expect(summary.failed).toBe(1);
  });
});

describe("importInvoices — validation", () => {
  it("rejects an unsupported currency", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "100", currency: "XYZ" }),
    ]);

    expect(summary.failed).toBe(1);
  });

  it("rejects a malformed date", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "100", issueDate: "01/01/2026" }),
    ]);

    expect(summary.failed).toBe(1);
  });

  it("rejects a due date before the issue date", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({
        sourceRow: 1,
        invoiceNumber: "INV-1",
        customerEmail: customer.email!,
        amount: "100",
        issueDate: "2026-01-15",
        dueDate: "2026-01-01",
      }),
    ]);

    expect(summary.failed).toBe(1);
    expect(summary.rows[0]!.field).toBe("dueDate");
  });

  it("rejects a row with no matching customer", async () => {
    const { organization } = await createTestOrganization();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: "nobody@example.com", amount: "100" }),
    ]);

    expect(summary.failed).toBe(1);
    expect(summary.rows[0]!.field).toBe("customerEmail");
  });

  it("rejects a row whose customer email matches more than one customer in the org", async () => {
    const { organization } = await createTestOrganization();
    await createCustomer(organization.id, { name: "First", email: "shared@example.com" });
    await createCustomer(organization.id, { name: "Second", email: "shared@example.com" });

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: "shared@example.com", amount: "100" }),
    ]);

    expect(summary.failed).toBe(1);
    expect(summary.rows[0]!.message).toMatch(/multiple customers/i);
  });

  it("reports a malformed source row as failed without crashing the rest of the import", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "100" }),
      record({ sourceRow: 2, sourceError: "wrong number of columns" }),
      record({ sourceRow: 3, invoiceNumber: "INV-2", customerEmail: customer.email!, amount: "200" }),
    ]);

    expect(summary.created).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.rows[1]!.status).toBe("failed");
  });
});

describe("importInvoices — duplicates and conflicts", () => {
  it("rejects a duplicate invoice number within the same file", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "100" }),
      record({ sourceRow: 2, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "200" }),
    ]);

    expect(summary.created).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.rows[1]!.message).toMatch(/duplicate/i);
  });

  it("importing the exact same file twice is idempotent — the second run skips, never duplicates", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    const records = [record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "100" })];

    const first = await importInvoices(organization.id, records);
    const second = await importInvoices(organization.id, records);

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    const invoices = await prisma.invoice.findMany({ where: { organizationId: organization.id } });
    expect(invoices).toHaveLength(1);
  });

  it("reports a conflict (never overwrites) when an existing invoice number is re-imported with different data", async () => {
    const { organization, customer } = await setupOrgWithCustomer();
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2026-01-01",
      dueDate: "2026-01-15",
    });

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "999.99" }),
    ]);

    expect(summary.created).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.rows[0]!.message).toMatch(/different data/i);

    const invoice = await prisma.invoice.findFirstOrThrow({ where: { organizationId: organization.id, number: "INV-1" } });
    expect(invoice.amountMinor).toBe(majorToMinor(100)); // untouched
  });
});

describe("importInvoices — atomicity", () => {
  it("a mix of valid and invalid rows leaves the DB in a fully predictable state — every valid row created, every invalid row reported, nothing corrupted", async () => {
    const { organization, customer } = await setupOrgWithCustomer();

    const summary = await importInvoices(organization.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customer.email!, amount: "100" }),
      record({ sourceRow: 2, invoiceNumber: "INV-2", customerEmail: "nobody@example.com", amount: "100" }),
      record({ sourceRow: 3, invoiceNumber: "INV-3", customerEmail: customer.email!, amount: "not-a-number" }),
      record({ sourceRow: 4, invoiceNumber: "INV-4", customerEmail: customer.email!, amount: "300" }),
    ]);

    expect(summary.totalRows).toBe(4);
    expect(summary.created).toBe(2);
    expect(summary.failed).toBe(2);

    const invoices = await prisma.invoice.findMany({ where: { organizationId: organization.id }, orderBy: { number: "asc" } });
    expect(invoices.map((i) => i.number)).toEqual(["INV-1", "INV-4"]);
  });
});

describe("importInvoices — tenant isolation", () => {
  it("cannot match a customer belonging to another organization by email", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { customer: customerB } = await setupOrgWithCustomer("shared@example.com");
    void orgA;

    const summary = await importInvoices(orgA.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-1", customerEmail: customerB.email!, amount: "100" }),
    ]);

    expect(summary.failed).toBe(1);
    expect(summary.rows[0]!.message).toMatch(/no customer found/i);
  });

  it("an existing invoice number in another organization does not block this organization's import", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB, customer: customerB } = await setupOrgWithCustomer("acme-b@example.com");
    await createInvoice(orgB.id, {
      customerId: customerB.id,
      number: "INV-SHARED",
      currency: "USD",
      amountMinor: majorToMinor(500),
      issueDate: "2026-01-01",
      dueDate: "2026-01-15",
    });
    const customerA = await createCustomer(orgA.id, { name: "Acme A", email: "acme-a@example.com" });

    const summary = await importInvoices(orgA.id, [
      record({ sourceRow: 1, invoiceNumber: "INV-SHARED", customerEmail: customerA.email!, amount: "999" }),
    ]);

    expect(summary.created).toBe(1); // not treated as a conflict — different org entirely
    void orgB;
  });
});

describe("acceptance: fresh organization -> bulk import -> AR + Collections Automation", () => {
  it("an imported invoice is correct through existing AR queries and eligible for the existing Collections Automation pipeline", async () => {
    const { organization } = await createAutomationReadyOrg("Import Acceptance");

    const customerSummary = await importCustomers(organization.id, [
      { sourceRow: 1, name: "Imported Customer", email: "imported@example.com", phone: "" },
    ]);
    expect(customerSummary.created).toBe(1);

    // Overdue relative to "today" so it's eligible for detection as well as enrollment.
    const invoiceSummary = await importInvoices(organization.id, [
      {
        sourceRow: 1,
        invoiceNumber: "IMP-0001",
        customerEmail: "imported@example.com",
        amount: "742.50",
        currency: "USD",
        issueDate: "2020-01-01",
        dueDate: "2020-01-15",
      },
    ]);
    expect(invoiceSummary.created).toBe(1);

    const invoice = await prisma.invoice.findFirstOrThrow({ where: { organizationId: organization.id, number: "IMP-0001" } });

    // 1. Correct through the exact same AR query the invoice detail page uses.
    const { financials } = await getInvoiceWithFinancials(organization.id, invoice.id);
    expect(financials.amountMinor).toBe(majorToMinor(742.5));
    expect(financials.outstandingMinor).toBe(majorToMinor(742.5));
    expect(financials.paidMinor).toBe(0n);
    expect(financials.isOverdue).toBe(true);

    // 2. Eligible for the real Collections Automation pipeline — not mocked,
    // a real tick against the real database.
    await runAutomationTick(new Date(), { organizationId: organization.id });
    const sequence = await prisma.collectionSequence.findFirst({
      where: { organizationId: organization.id, invoiceId: invoice.id },
    });
    expect(sequence).not.toBeNull();
  });
});
