import { beforeEach, describe, expect, it } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { RateLimitExceededError } from "@/server/rate-limit/errors";
import { operatorRunPolicy } from "@/server/rate-limit/policies";
import { checkRateLimit } from "@/server/rate-limit/service";
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

    // Each invoice is deep overdue (issued 2020, due 2020-01-15), so both
    // INVOICE_OVERDUE and INVOICE_RISK_ESCALATED (HIGH bucket, reached
    // immediately) fire for each — 2 invoices x 2 event types = 4. Only
    // INVOICE_OVERDUE's insight ever creates a proposal (risk escalation
    // is insight-only, see events.ts), so proposalsCreated stays 2.
    expect(summary.eventsDetected).toBe(4);
    expect(summary.eventsNew).toBe(4);
    expect(summary.insightsCreated).toBe(4);
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
      proposalsMarkedStale: 0,
    });
  });

  it("is idempotent: running twice with nothing new creates no duplicates", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    await createOverdueInvoice(organization.id, customer.id, "INV-1");

    const first = await runOperator(organization.id);
    const second = await runOperator(organization.id);

    // Deep overdue -> both INVOICE_OVERDUE and INVOICE_RISK_ESCALATED
    // (HIGH) fire on the one invoice; only the former creates a proposal.
    expect(first.eventsNew).toBe(2);
    expect(first.insightsCreated).toBe(2);
    expect(first.proposalsCreated).toBe(1);

    expect(second.eventsDetected).toBe(2);
    expect(second.eventsNew).toBe(0);
    expect(second.insightsCreated).toBe(0);
    expect(second.proposalsCreated).toBe(0);

    const eventCount = await prisma.businessEvent.count({ where: { organizationId: organization.id } });
    const insightCount = await prisma.operatorInsight.count({ where: { organizationId: organization.id } });
    const proposalCount = await prisma.actionProposal.count({ where: { organizationId: organization.id } });
    expect(eventCount).toBe(2);
    expect(insightCount).toBe(2);
    expect(proposalCount).toBe(1);
  });

  it("picks up a newly-overdue invoice on a later run without re-processing the first one", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    await createOverdueInvoice(organization.id, customer.id, "INV-1");

    await runOperator(organization.id);
    await createOverdueInvoice(organization.id, customer.id, "INV-2");
    const second = await runOperator(organization.id);

    // INV-1 already has both event types from the first run (not new);
    // INV-2 is also deep overdue, so it produces both types fresh —
    // 2 invoices x 2 event types detected = 4, only INV-2's 2 are new.
    expect(second.eventsDetected).toBe(4);
    expect(second.eventsNew).toBe(2);
    expect(second.insightsCreated).toBe(2);
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

describe("runOperator — abuse control / operator-run rate limit (P1-7)", () => {
  it("refuses to run once the organization's hourly run budget is exhausted", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme Co" });
    await createOverdueInvoice(organization.id, customer.id, "INV-1");

    const policy = operatorRunPolicy();
    for (let i = 0; i < policy.maxAttempts; i += 1) {
      await checkRateLimit("operator:run", organization.id, policy);
    }

    await expect(runOperator(organization.id)).rejects.toThrow(RateLimitExceededError);

    // Blocked before doing any work — no event/insight/proposal created by the refused call.
    const proposals = await prisma.actionProposal.count({ where: { organizationId: organization.id } });
    expect(proposals).toBe(0);
  }, 20000);

  it("a different organization's run budget is unaffected by another organization's exhausted limit", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerB = await createCustomer(orgB.id, { name: "B Customer" });
    await createOverdueInvoice(orgB.id, customerB.id, "INV-1");

    const policy = operatorRunPolicy();
    for (let i = 0; i < policy.maxAttempts; i += 1) {
      await checkRateLimit("operator:run", orgA.id, policy);
    }

    await expect(runOperator(orgA.id)).rejects.toThrow(RateLimitExceededError);

    const summaryB = await runOperator(orgB.id);
    // Deep overdue -> both INVOICE_OVERDUE and INVOICE_RISK_ESCALATED fire.
    expect(summaryB.eventsNew).toBe(2); // org B's budget is untouched
  }, 20000);
});
