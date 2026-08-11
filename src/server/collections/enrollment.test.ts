import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { majorToMinor } from "@/server/ar/money";
import { recordPayment } from "@/server/ar/payments";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { enrollEligibleInvoices, enrollInvoice } from "./enrollment";
import { createAutomationReadyOrg, createTestInvoice } from "./test-fixtures";

beforeEach(async () => {
  await resetDatabase();
});

describe("enrollInvoice", () => {
  it("enrolls an invoice and is idempotent on repeat calls", async () => {
    const { organization, customer, policy } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");

    const first = await enrollInvoice(organization.id, invoice.id, customer.id, policy.id, policy.currentVersion);
    const second = await enrollInvoice(organization.id, invoice.id, customer.id, policy.id, policy.currentVersion);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sequence.id).toBe(first.sequence.id);

    const count = await prisma.collectionSequence.count({ where: { organizationId: organization.id, invoiceId: invoice.id } });
    expect(count).toBe(1);
  });

  it("locks in the policy's current version at enrollment time", async () => {
    const { organization, customer, policy } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const { sequence } = await enrollInvoice(organization.id, invoice.id, customer.id, policy.id, policy.currentVersion);
    expect(sequence.policyVersion).toBe(1);
  });

});

describe("enrollEligibleInvoices", () => {
  it("enrolls every eligible OPEN invoice and skips already-enrolled ones", async () => {
    const { organization, customer, policy } = await createAutomationReadyOrg();
    const invoiceA = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const invoiceB = await createTestInvoice(organization.id, customer.id, "2026-01-05");

    const first = await enrollEligibleInvoices(organization.id, policy.id, policy.currentVersion);
    expect(first).toHaveLength(2);
    expect(first.every((r) => r.created)).toBe(true);

    const second = await enrollEligibleInvoices(organization.id, policy.id, policy.currentVersion);
    expect(second.every((r) => !r.created)).toBe(true);

    const ids = new Set((await prisma.collectionSequence.findMany({ where: { organizationId: organization.id } })).map((s) => s.invoiceId));
    expect(ids).toEqual(new Set([invoiceA.id, invoiceB.id]));
  });

  it("does not enroll a fully paid invoice", async () => {
    const { organization, customer, policy } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01", 100);
    await recordPayment(organization.id, invoice.id, { amountMinor: majorToMinor(100), paidAt: "2026-01-02" });

    const results = await enrollEligibleInvoices(organization.id, policy.id, policy.currentVersion);
    expect(results).toHaveLength(0);
  });

  it("does not enroll a cancelled invoice", async () => {
    const { organization, customer, policy } = await createAutomationReadyOrg();
    const { cancelInvoice } = await import("@/server/ar/invoices");
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    await cancelInvoice(organization.id, invoice.id);

    const results = await enrollEligibleInvoices(organization.id, policy.id, policy.currentVersion);
    expect(results).toHaveLength(0);
  });

  it("does not enroll an invoice for an archived customer", async () => {
    const { organization, policy } = await createAutomationReadyOrg();
    const archivedCustomer = await createCustomer(organization.id, { name: "Gone Co", email: "gone@example.com" });
    await prisma.customer.update({ where: { id: archivedCustomer.id }, data: { archivedAt: new Date() } });
    await createTestInvoice(organization.id, archivedCustomer.id, "2026-01-01");

    const results = await enrollEligibleInvoices(organization.id, policy.id, policy.currentVersion);
    expect(results).toHaveLength(0);
  });
});
