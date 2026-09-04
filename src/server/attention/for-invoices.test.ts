import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { resetDatabase } from "@/server/db/test-utils";
import { getAttentionScoresForInvoiceIds } from "./for-invoices";

beforeEach(async () => {
  await resetDatabase();
});

async function createOverdueInvoice(organizationId: string, customerId: string, number: string, amountMajor: number) {
  return createInvoice(organizationId, {
    customerId,
    number,
    currency: "USD",
    amountMinor: majorToMinor(amountMajor),
    issueDate: "2020-01-01",
    dueDate: "2020-01-15",
  });
}

describe("getAttentionScoresForInvoiceIds", () => {
  it("returns an empty map for an empty invoice id list without querying the database", async () => {
    const result = await getAttentionScoresForInvoiceIds("does-not-matter", []);
    expect(result.size).toBe(0);
  });

  it("scores a real overdue invoice with a positive days-overdue and priority", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const invoice = await createOverdueInvoice(organization.id, customer.id, "INV-1", 500);

    const result = await getAttentionScoresForInvoiceIds(organization.id, [invoice.id]);
    const scored = result.get(invoice.id);

    expect(scored).toBeDefined();
    expect(scored!.daysOverdue).toBeGreaterThan(0);
    expect(scored!.priority).toBe("HIGH");
    expect(scored!.attention.score).toBeGreaterThan(0);
  });

  it("is tenant-scoped: an invoice id from another organization never appears in the result", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    const invoiceA = await createOverdueInvoice(orgA.id, customerA.id, "INV-1", 500);

    // Ask orgB's scope for an invoice that actually belongs to orgA.
    const result = await getAttentionScoresForInvoiceIds(orgB.id, [invoiceA.id]);

    expect(result.size).toBe(0);
  });

  it("reflects hasUnresolvedAction from the caller-supplied set, not a hidden default", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const invoice = await createOverdueInvoice(organization.id, customer.id, "INV-1", 500);

    const withoutAction = await getAttentionScoresForInvoiceIds(organization.id, [invoice.id]);
    const withAction = await getAttentionScoresForInvoiceIds(organization.id, [invoice.id], new Set([invoice.id]));

    expect(withoutAction.get(invoice.id)!.attention.score).toBeLessThan(withAction.get(invoice.id)!.attention.score);
  });

  it("normalizes the amount factor against the largest outstanding balance in the same batch", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const small = await createOverdueInvoice(organization.id, customer.id, "INV-SMALL", 10);
    const large = await createOverdueInvoice(organization.id, customer.id, "INV-LARGE", 1000);

    const result = await getAttentionScoresForInvoiceIds(organization.id, [small.id, large.id]);

    expect(result.get(large.id)!.attention.score).toBeGreaterThan(result.get(small.id)!.attention.score);
  });
});
