import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "./customers";
import { createInvoice } from "./invoices";
import { majorToMinor } from "./money";
import { createTestOrganization } from "./test-fixtures";
import { resetDatabase } from "@/server/db/test-utils";
import { buildDeterministicInvoiceContext } from "./reminder-context";

beforeEach(async () => {
  await resetDatabase();
});

describe("buildDeterministicInvoiceContext", () => {
  it("computes facts live from the current invoice/customer state, not a snapshot", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, {
      name: "Acme Co",
      notes: "Prefers email contact.",
    });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(500),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });

    const context = await buildDeterministicInvoiceContext(organization.id, invoice.id);

    expect(context.invoiceNumber).toBe("INV-1");
    expect(context.currency).toBe("USD");
    expect(context.outstandingAmount).toBe("$500.00");
    expect(context.dueDate).toBe("2020-01-15");
    expect(context.daysOverdue).toBeGreaterThan(0);
    expect(context.customerName).toBe("Acme Co");
    expect(context.customerNotes).toBe("Prefers email contact.");
  });

  it("omits customerNotes when the customer has none", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(500),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });

    const context = await buildDeterministicInvoiceContext(organization.id, invoice.id);
    expect(context.customerNotes).toBeUndefined();
  });

  it("is tenant-scoped: rejects an invoice id belonging to another organization", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerB = await createCustomer(orgB.id, { name: "B Customer" });
    const invoice = await createInvoice(orgB.id, {
      customerId: customerB.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(500),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });

    await expect(buildDeterministicInvoiceContext(orgA.id, invoice.id)).rejects.toThrow();
  });
});
