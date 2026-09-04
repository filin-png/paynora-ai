import Papa from "papaparse";
import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "./customers";
import { exportCustomersCsv, exportInvoicesCsv, exportPaymentsCsv } from "./export";
import { createInvoice } from "./invoices";
import { majorToMinor } from "./money";
import { recordPayment } from "./payments";
import { createTestOrganization } from "./test-fixtures";
import { resetDatabase } from "@/server/db/test-utils";

beforeEach(async () => {
  await resetDatabase();
});

function parseCsv(csv: string): Record<string, string>[] {
  const result = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  return result.data;
}

describe("exportCustomersCsv", () => {
  it("includes every customer for the organization with real field values", async () => {
    const { organization } = await createTestOrganization();
    await createCustomer(organization.id, { name: "Acme Co", email: "billing@acme.example" });

    const rows = parseCsv(await exportCustomersCsv(organization.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Acme Co");
    expect(rows[0].email).toBe("billing@acme.example");
    expect(rows[0].archived).toBe("no");
  });

  it("is tenant-scoped: never includes another organization's customers", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    await createCustomer(orgA.id, { name: "A Customer" });
    await createCustomer(orgB.id, { name: "B Customer" });

    const rows = parseCsv(await exportCustomersCsv(orgA.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("A Customer");
  });

  it("returns a header row with no data rows for an organization with no customers", async () => {
    const { organization } = await createTestOrganization();

    const csv = await exportCustomersCsv(organization.id);

    expect(csv).toContain("name");
    expect(parseCsv(csv)).toHaveLength(0);
  });

  it("correctly quotes a name containing a comma", async () => {
    const { organization } = await createTestOrganization();
    await createCustomer(organization.id, { name: "Acme, Inc." });

    const rows = parseCsv(await exportCustomersCsv(organization.id));

    expect(rows[0].name).toBe("Acme, Inc.");
  });
});

describe("exportInvoicesCsv", () => {
  it("includes amount and outstanding as plain decimal strings, no currency symbol", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(1500),
      issueDate: "2020-01-01",
      dueDate: "2099-01-15",
    });

    const rows = parseCsv(await exportInvoicesCsv(organization.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe("INV-1");
    expect(rows[0].amount).toBe("1500.00");
    expect(rows[0].outstanding).toBe("1500.00");
    expect(rows[0].is_paid).toBe("no");
  });

  it("is tenant-scoped: never includes another organization's invoices", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    await createInvoice(orgA.id, {
      customerId: customerA.id,
      number: "INV-A",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2020-01-01",
      dueDate: "2099-01-15",
    });

    const rows = parseCsv(await exportInvoicesCsv(orgB.id));

    expect(rows).toHaveLength(0);
  });
});

describe("exportPaymentsCsv", () => {
  it("includes real recorded payments with invoice/customer context", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(300),
      issueDate: "2020-01-01",
      dueDate: "2099-01-15",
    });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(300), paidAt: "2020-01-05" });

    const rows = parseCsv(await exportPaymentsCsv(organization.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].invoice_number).toBe("INV-1");
    expect(rows[0].customer_name).toBe("Acme Co");
    expect(rows[0].amount).toBe("300.00");
    expect(rows[0].paid_at).toBe("2020-01-05");
  });

  it("is tenant-scoped: never includes another organization's payments", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    const invoiceA = await createInvoice(orgA.id, {
      customerId: customerA.id,
      number: "INV-A",
      currency: "USD",
      amountMinor: majorToMinor(300),
      issueDate: "2020-01-01",
      dueDate: "2099-01-15",
    });
    await recordPayment(orgA.id, invoiceA.id, { amountMinor: majorToMinor(300), paidAt: "2020-01-05" });

    const rows = parseCsv(await exportPaymentsCsv(orgB.id));

    expect(rows).toHaveLength(0);
  });
});
