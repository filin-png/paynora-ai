import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { recordPayment } from "@/server/ar/payments";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { resetDatabase } from "@/server/db/test-utils";
import { computePaymentOutlook, getPaymentOutlookForInvoiceIds } from "./payment-outlook";

beforeEach(async () => {
  await resetDatabase();
});

const INSUFFICIENT = { status: "insufficient-history" as const };
const STABLE = {
  status: "stable" as const,
  recentAvgDelayDays: 2,
  previousAvgDelayDays: 2,
  deltaDays: 0,
  recentPaymentCount: 3,
  previousPaymentCount: 3,
};
const DETERIORATING = {
  status: "deteriorating" as const,
  recentAvgDelayDays: 10,
  previousAvgDelayDays: 3,
  deltaDays: 7,
  recentPaymentCount: 3,
  previousPaymentCount: 3,
};
const IMPROVING = {
  status: "improving" as const,
  recentAvgDelayDays: 1,
  previousAvgDelayDays: 8,
  deltaDays: -7,
  recentPaymentCount: 3,
  previousPaymentCount: 3,
};

describe("computePaymentOutlook", () => {
  it("bands a not-yet-due invoice as on-track regardless of trend", () => {
    expect(computePaymentOutlook("2099-01-01", null, INSUFFICIENT).band).toBe("on-track");
    expect(computePaymentOutlook("2099-01-01", null, STABLE).band).toBe("on-track");
  });

  it("bands a HIGH-priority overdue invoice as at-risk even with a stable trend", () => {
    const outlook = computePaymentOutlook("2020-01-01", "HIGH", STABLE);
    expect(outlook.band).toBe("at-risk");
    expect(outlook.explanation).toContain("already significantly overdue");
  });

  it("bands a LOW/MEDIUM overdue invoice as at-risk when the customer's trend is deteriorating", () => {
    const outlook = computePaymentOutlook("2020-01-01", "MEDIUM", DETERIORATING);
    expect(outlook.band).toBe("at-risk");
    expect(outlook.explanation).toContain("deteriorating");
  });

  it("bands a LOW/MEDIUM overdue invoice as insufficient-history when there's no real trend data — never invents one", () => {
    const outlook = computePaymentOutlook("2020-01-01", "MEDIUM", INSUFFICIENT);
    expect(outlook.band).toBe("insufficient-history");
    expect(outlook.expectedPaymentDate).toBeNull();
  });

  it("bands a LOW/MEDIUM overdue invoice as likely when the trend is stable or improving", () => {
    expect(computePaymentOutlook("2020-01-01", "LOW", STABLE).band).toBe("likely");
    expect(computePaymentOutlook("2020-01-01", "LOW", IMPROVING).band).toBe("likely");
  });

  it("projects the expected payment date from the due date plus the customer's own real average delay — never a guess with no history behind it", () => {
    const outlook = computePaymentOutlook("2020-01-10", "LOW", STABLE);
    expect(outlook.expectedPaymentDate).toBe("2020-01-12");
  });
});

describe("getPaymentOutlookForInvoiceIds", () => {
  it("never returns an outlook for a fully paid invoice", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2020-01-10" });

    const outlooks = await getPaymentOutlookForInvoiceIds(organization.id, [invoice.id], "2020-06-01");
    expect(outlooks.has(invoice.id)).toBe(false);
  });

  it("tenant isolation: an invoice id from another organization is silently absent, never leaked", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    const invoiceA = await createInvoice(orgA.id, {
      customerId: customerA.id,
      number: "INV-CROSS-1",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });

    const outlooks = await getPaymentOutlookForInvoiceIds(orgB.id, [invoiceA.id], "2020-06-01");
    expect(outlooks.size).toBe(0);
  });
});
