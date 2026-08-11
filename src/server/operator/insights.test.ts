import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { detectInvoiceOverdueEvents } from "./events";
import { computeOverduePriority, ensureInsightForInvoiceOverdueEvent } from "./insights";

beforeEach(async () => {
  await resetDatabase();
});

describe("computeOverduePriority", () => {
  it("is LOW just after becoming overdue", () => {
    expect(computeOverduePriority(1)).toBe("LOW");
    expect(computeOverduePriority(6)).toBe("LOW");
  });

  it("is MEDIUM from 7 days overdue", () => {
    expect(computeOverduePriority(7)).toBe("MEDIUM");
    expect(computeOverduePriority(29)).toBe("MEDIUM");
  });

  it("is HIGH from 30 days overdue", () => {
    expect(computeOverduePriority(30)).toBe("HIGH");
    expect(computeOverduePriority(365)).toBe("HIGH");
  });
});

async function createOverdueEvent(organizationId: string, customerId: string, dueDate: string) {
  const invoice = await createInvoice(organizationId, {
    customerId,
    number: `INV-${Math.random().toString(36).slice(2, 8)}`,
    currency: "USD",
    amountMinor: majorToMinor(250),
    issueDate: "2020-01-01",
    dueDate,
  });
  const [{ event }] = await detectInvoiceOverdueEvents(organizationId);
  return { invoice, event };
}

describe("ensureInsightForInvoiceOverdueEvent", () => {
  it("creates an insight with a deterministic priority and summary when AI is disabled (the test/CI default)", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { invoice, event } = await createOverdueEvent(organization.id, customer.id, "2020-01-15");

    const { insight, created } = await ensureInsightForInvoiceOverdueEvent(organization.id, event);

    expect(created).toBe(true);
    expect(insight.aiGenerated).toBe(false);
    expect(insight.aiProvider).toBeNull();
    expect(insight.priority).toBe("HIGH"); // due 2020-01-15, deep in the past
    expect(insight.summary).toContain(invoice.number);
    expect(insight.summary).toContain("Acme Co");
    expect(insight.businessEventId).toBe(event.id);
    expect(insight.invoiceId).toBe(invoice.id);
    expect(insight.customerId).toBe(customer.id);
  });

  it("is idempotent: a second call for the same event returns the existing insight", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { event } = await createOverdueEvent(organization.id, customer.id, "2020-01-15");

    const first = await ensureInsightForInvoiceOverdueEvent(organization.id, event);
    const second = await ensureInsightForInvoiceOverdueEvent(organization.id, event);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.insight.id).toBe(first.insight.id);

    const count = await prisma.operatorInsight.count({ where: { organizationId: organization.id } });
    expect(count).toBe(1);
  });

  it("never changes any Invoice/Payment row — insight creation is read-only over AR data", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const { invoice, event } = await createOverdueEvent(organization.id, customer.id, "2020-01-15");

    await ensureInsightForInvoiceOverdueEvent(organization.id, event);

    const reloaded = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reloaded.status).toBe("OPEN");
    expect(reloaded.amountMinor).toBe(invoice.amountMinor);
  });
});
