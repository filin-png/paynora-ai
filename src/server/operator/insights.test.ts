import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { recordPayment } from "@/server/ar/payments";
import { detectInvoiceOverdueEvents, detectPaymentReceivedEvents } from "./events";
import {
  computeOverduePriority,
  ensureInsightForCustomerBehaviorEvent,
  ensureInsightForInvoiceOverdueEvent,
  ensureInsightForPaymentReceivedEvent,
} from "./insights";

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

describe("ensureInsightForPaymentReceivedEvent", () => {
  it("creates a LOW-priority, never-AI insight from the payment's own data snapshot", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-PAY-1",
      currency: "USD",
      amountMinor: majorToMinor(250),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(250), paidAt: "2020-01-20" });
    const [{ event }] = await detectPaymentReceivedEvents(organization.id);

    const { insight, created } = await ensureInsightForPaymentReceivedEvent(organization.id, event);

    expect(created).toBe(true);
    expect(insight.priority).toBe("LOW");
    expect(insight.aiGenerated).toBe(false);
    expect(insight.summary).toContain(invoice.number);
    expect(insight.summary).toContain("250");
  });

  it("is idempotent: a second call returns the existing insight", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-PAY-2",
      currency: "USD",
      amountMinor: majorToMinor(250),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(250), paidAt: "2020-01-20" });
    const [{ event }] = await detectPaymentReceivedEvents(organization.id);

    const first = await ensureInsightForPaymentReceivedEvent(organization.id, event);
    const second = await ensureInsightForPaymentReceivedEvent(organization.id, event);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.insight.id).toBe(first.insight.id);
  });
});

describe("ensureInsightForCustomerBehaviorEvent", () => {
  it("creates a MEDIUM-priority insight summarizing the deterioration from the event's own data", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    // Fabricate a CUSTOMER_PAYMENT_BEHAVIOR_DETERIORATED-shaped event directly
    // (the detector itself is tested separately in events.test.ts) — this
    // test is only about the insight function's own behavior.
    const event = await prisma.businessEvent.create({
      data: {
        organizationId: organization.id,
        type: "CUSTOMER_PAYMENT_BEHAVIOR_DETERIORATED",
        customerId: customer.id,
        dedupeKey: `${customer.id}:test-week`,
        data: { recentAvgDelayDays: 12, previousAvgDelayDays: 2, deltaDays: 10, detectedOn: "2020-01-01" },
      },
    });

    const { insight, created } = await ensureInsightForCustomerBehaviorEvent(organization.id, event);

    expect(created).toBe(true);
    expect(insight.priority).toBe("MEDIUM");
    expect(insight.aiGenerated).toBe(false);
    expect(insight.summary).toContain("12");
    expect(insight.summary).toContain("2");
    expect(insight.customerId).toBe(customer.id);
  });
});
