import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { runOperator } from "./pipeline";

beforeEach(async () => {
  await resetDatabase();
});

async function createOverdueInvoice(organizationId: string, customerId: string, number: string) {
  return createInvoice(organizationId, {
    customerId,
    number,
    currency: "USD",
    amountMinor: majorToMinor(500),
    issueDate: "2020-01-01",
    dueDate: "2020-01-15",
  });
}

describe("runOperator", () => {
  it("runs the full pipeline end to end for a fresh org", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    await createOverdueInvoice(organization.id, customer.id, "INV-1");
    await createOverdueInvoice(organization.id, customer.id, "INV-2");

    const summary = await runOperator(organization.id);

    expect(summary.eventsDetected).toBe(2);
    expect(summary.eventsNew).toBe(2);
    expect(summary.insightsCreated).toBe(2);
    expect(summary.proposalsCreated).toBe(2);
    expect(summary.failures).toBe(0);

    const proposals = await prisma.actionProposal.findMany({ where: { organizationId: organization.id } });
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.status === "PENDING")).toBe(true);
  });

  it("does nothing for an organization with no overdue invoices", async () => {
    const { organization } = await createTestOrganization();
    const summary = await runOperator(organization.id);

    expect(summary).toEqual({
      eventsDetected: 0,
      eventsNew: 0,
      insightsCreated: 0,
      proposalsCreated: 0,
      aiGeneratedInsights: 0,
      failures: 0,
    });
  });

  it("is idempotent: running twice with nothing new creates no duplicates", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    await createOverdueInvoice(organization.id, customer.id, "INV-1");

    const first = await runOperator(organization.id);
    const second = await runOperator(organization.id);

    expect(first.eventsNew).toBe(1);
    expect(first.insightsCreated).toBe(1);
    expect(first.proposalsCreated).toBe(1);

    expect(second.eventsDetected).toBe(1);
    expect(second.eventsNew).toBe(0);
    expect(second.insightsCreated).toBe(0);
    expect(second.proposalsCreated).toBe(0);

    const eventCount = await prisma.businessEvent.count({ where: { organizationId: organization.id } });
    const insightCount = await prisma.operatorInsight.count({ where: { organizationId: organization.id } });
    const proposalCount = await prisma.actionProposal.count({ where: { organizationId: organization.id } });
    expect(eventCount).toBe(1);
    expect(insightCount).toBe(1);
    expect(proposalCount).toBe(1);
  });

  it("picks up a newly-overdue invoice on a later run without re-processing the first one", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    await createOverdueInvoice(organization.id, customer.id, "INV-1");

    await runOperator(organization.id);
    await createOverdueInvoice(organization.id, customer.id, "INV-2");
    const second = await runOperator(organization.id);

    expect(second.eventsDetected).toBe(2);
    expect(second.eventsNew).toBe(1);
    expect(second.insightsCreated).toBe(1);
    expect(second.proposalsCreated).toBe(1);
  });

  it("is tenant-scoped: running for one org never touches another org's data", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerA = await createCustomer(orgA.id, { name: "A Customer" });
    await createOverdueInvoice(orgA.id, customerA.id, "INV-1");

    await runOperator(orgB.id);

    const proposalsForB = await prisma.actionProposal.count({ where: { organizationId: orgB.id } });
    expect(proposalsForB).toBe(0);
  });
});
