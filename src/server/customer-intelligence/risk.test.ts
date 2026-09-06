import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { resetDatabase } from "@/server/db/test-utils";
import { getCustomerRiskProfile } from "./risk";

beforeEach(async () => {
  await resetDatabase();
});

describe("getCustomerRiskProfile", () => {
  it("reports 'none' risk and no recommended action beyond 'nothing needs action' for a customer with no overdue invoices", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-1",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2020-01-01",
      dueDate: "2099-01-15",
    });

    const profile = await getCustomerRiskProfile(organization.id, customer.id);
    expect(profile.riskLevel).toBe("none");
    expect(profile.currentRiskScore).toBe(0);
    expect(profile.openOverdueInvoiceCount).toBe(0);
    expect(profile.recommendedNextAction).toContain("nothing needs action");
  });

  it("reports a real risk score (matching the same attention-score algorithm the invoice list uses) for a customer with an overdue invoice, and recommends running the operator", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-2",
      currency: "USD",
      amountMinor: majorToMinor(500),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });

    const profile = await getCustomerRiskProfile(organization.id, customer.id);
    expect(profile.currentRiskScore).toBeGreaterThan(0);
    expect(profile.riskLevel).not.toBe("none");
    expect(profile.openOverdueInvoiceCount).toBe(1);
    expect(profile.recommendedNextAction).toContain("Check for new actions");
  });

  it("tenant isolation: never includes another organization's invoices in the risk score", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    await createInvoice(orgA.id, {
      customerId: customerA.id,
      number: "INV-A-1",
      currency: "USD",
      amountMinor: majorToMinor(9999),
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
    });
    const customerB = await createCustomer(orgB.id, { name: "B Customer" });

    const profile = await getCustomerRiskProfile(orgB.id, customerB.id);
    expect(profile.riskLevel).toBe("none");
    expect(profile.openOverdueInvoiceCount).toBe(0);
  });
});
