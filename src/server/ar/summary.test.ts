import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createCustomer } from "./customers";
import { createInvoice } from "./invoices";
import { majorToMinor } from "./money";
import { recordPayment } from "./payments";
import { getInvoicesRequiringAttention, getOrganizationArSummary } from "./summary";
import { createTestOrganization } from "./test-fixtures";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("getOrganizationArSummary", () => {
  it("returns an empty array for an organization with no invoices", async () => {
    const { organization } = await createTestOrganization();
    expect(await getOrganizationArSummary(organization.id)).toEqual([]);
  });

  it("computes outstanding and overdue totals for a single currency", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });

    // Overdue, unpaid
    const overdueInvoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-0001",
      currency: "USD",
      amountMinor: majorToMinor(1000),
      issueDate: "2026-01-01",
      dueDate: "2026-01-15",
    });
    // Not yet due
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-0002",
      currency: "USD",
      amountMinor: majorToMinor(500),
      issueDate: "2026-08-01",
      dueDate: "2099-01-01",
    });

    const summary = await getOrganizationArSummary(organization.id);
    const usd = summary.find((s) => s.currency === "USD");

    expect(usd?.totalOutstandingMinor).toBe(majorToMinor(1500));
    expect(usd?.totalOverdueMinor).toBe(majorToMinor(1000));
    expect(usd?.openInvoiceCount).toBe(2);
    expect(usd?.overdueInvoiceCount).toBe(1);
    void overdueInvoice;
  });

  it("keeps currencies separate rather than combining totals", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });

    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-USD",
      currency: "USD",
      amountMinor: majorToMinor(1000),
      issueDate: "2026-08-01",
      dueDate: "2099-01-01",
    });
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-RUB",
      currency: "RUB",
      amountMinor: majorToMinor(50_000),
      issueDate: "2026-08-01",
      dueDate: "2099-01-01",
    });

    const summary = await getOrganizationArSummary(organization.id);

    expect(summary).toHaveLength(2);
    const usd = summary.find((s) => s.currency === "USD");
    const rub = summary.find((s) => s.currency === "RUB");
    expect(usd?.totalOutstandingMinor).toBe(majorToMinor(1000));
    expect(rub?.totalOutstandingMinor).toBe(majorToMinor(50_000));
    // No entry mixes the two currencies' amounts.
    expect(summary.every((s) => s.totalOutstandingMinor !== majorToMinor(51_000))).toBe(true);
  });

  it("excludes fully paid invoices from outstanding totals", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-0001",
      currency: "USD",
      amountMinor: majorToMinor(1000),
      issueDate: "2026-01-01",
      dueDate: "2026-01-15",
    });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(1000), paidAt: "2026-01-10" });

    const summary = await getOrganizationArSummary(organization.id);
    expect(summary).toEqual([]);
  });

  it("only includes the requesting organization's invoices", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerB = await createCustomer(orgB.id, { name: "Org B Customer" });
    await createInvoice(orgB.id, {
      customerId: customerB.id,
      number: "INV-0001",
      currency: "USD",
      amountMinor: majorToMinor(1000),
      issueDate: "2026-08-01",
      dueDate: "2099-01-01",
    });

    expect(await getOrganizationArSummary(orgA.id)).toEqual([]);
  });
});

describe("getInvoicesRequiringAttention", () => {
  it("includes overdue invoices before invoices due soon", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-FUTURE",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2026-08-01",
      dueDate: "2099-01-01", // far future — not "due soon"
    });
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-OVERDUE",
      currency: "USD",
      amountMinor: majorToMinor(200),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15", // long overdue
    });

    const attention = await getInvoicesRequiringAttention(organization.id);

    expect(attention.map((a) => a.invoice.number)).toEqual(["INV-OVERDUE"]);
    expect(attention[0]?.reason).toBe("overdue");
  });

  it("excludes fully paid invoices", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-0001",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-01-10" });

    expect(await getInvoicesRequiringAttention(organization.id)).toEqual([]);
  });
});
