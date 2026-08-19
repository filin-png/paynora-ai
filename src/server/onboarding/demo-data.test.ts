import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { clearDemoData, seedDemoData } from "./demo-data";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("seedDemoData", () => {
  it("creates a realistic mix of current, overdue, partially paid, and paid invoices", async () => {
    const { organization } = await createTestOrganization();

    const result = await seedDemoData(organization.id);

    expect(result.status).toBe("seeded");
    if (result.status !== "seeded") throw new Error("unreachable");
    expect(result.customerCount).toBeGreaterThan(0);
    expect(result.invoiceCount).toBeGreaterThan(0);

    const customers = await prisma.customer.findMany({ where: { organizationId: organization.id } });
    expect(customers.length).toBe(result.customerCount);
    expect(customers.every((c) => c.email?.endsWith("@demo.paynora.internal"))).toBe(true);

    const invoices = await prisma.invoice.findMany({
      where: { organizationId: organization.id },
      include: { payments: true },
    });
    expect(invoices.length).toBe(result.invoiceCount);
    // At least one invoice with no payments (current/overdue) and at least one fully paid.
    expect(invoices.some((inv) => inv.payments.length === 0)).toBe(true);
    expect(
      invoices.some((inv) => {
        const paid = inv.payments.reduce((sum, p) => sum + p.amountMinor, 0n);
        return paid > 0n && paid < inv.amountMinor;
      }),
    ).toBe(true);
    expect(
      invoices.some((inv) => {
        const paid = inv.payments.reduce((sum, p) => sum + p.amountMinor, 0n);
        return paid === inv.amountMinor;
      }),
    ).toBe(true);
  });

  it("is idempotent — calling it again reports already_seeded and creates no duplicates", async () => {
    const { organization } = await createTestOrganization();
    const first = await seedDemoData(organization.id);
    if (first.status !== "seeded") throw new Error("unreachable");

    const second = await seedDemoData(organization.id);
    expect(second.status).toBe("already_seeded");

    const customerCount = await prisma.customer.count({ where: { organizationId: organization.id } });
    expect(customerCount).toBe(first.customerCount);
  });

  it("never touches another organization's data", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");

    await seedDemoData(orgA.id);

    const orgBCustomers = await prisma.customer.count({ where: { organizationId: orgB.id } });
    expect(orgBCustomers).toBe(0);
  });
});

describe("clearDemoData", () => {
  it("archives demo customers and cancels their unpaid open invoices, but keeps paid history", async () => {
    const { organization } = await createTestOrganization();
    await seedDemoData(organization.id);

    const result = await clearDemoData(organization.id);
    expect(result.status).toBe("cleared");

    const customers = await prisma.customer.findMany({ where: { organizationId: organization.id } });
    expect(customers.every((c) => c.archivedAt !== null)).toBe(true);

    const invoices = await prisma.invoice.findMany({
      where: { organizationId: organization.id },
      include: { payments: true },
    });
    for (const invoice of invoices) {
      const paid = invoice.payments.reduce((sum, p) => sum + p.amountMinor, 0n);
      if (paid > 0n) {
        // Financial history is never cancelled/deleted.
        expect(invoice.status).toBe("OPEN");
      } else {
        expect(invoice.status).toBe("CANCELLED");
      }
    }
  });

  it("reports nothing_to_clear for an organization with no demo data, and never touches another org", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    await seedDemoData(orgB.id);

    const result = await clearDemoData(orgA.id);
    expect(result.status).toBe("nothing_to_clear");

    const orgBCustomers = await prisma.customer.findMany({ where: { organizationId: orgB.id } });
    expect(orgBCustomers.every((c) => c.archivedAt === null)).toBe(true);
  });

  it("is safe to call repeatedly", async () => {
    const { organization } = await createTestOrganization();
    await seedDemoData(organization.id);

    await clearDemoData(organization.id);
    const second = await clearDemoData(organization.id);
    expect(second.status).toBe("nothing_to_clear");
  });
});
