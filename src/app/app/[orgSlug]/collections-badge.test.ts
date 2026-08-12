import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { majorToMinor } from "@/server/ar/money";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import type { CollectionStatusView } from "@/server/collections/sequences";
import { getCollectionsBadgeView, getCollectionsBadgesForInvoices } from "./collections-badge";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("getCollectionsBadgeView", () => {
  it("maps every CollectionStatusView kind to the same five human-readable words the automation page uses", () => {
    expect(getCollectionsBadgeView({ kind: "not_enrolled" })).toBeNull();
    expect(getCollectionsBadgeView({ kind: "completed", stopReason: null })).toEqual({ label: "Completed", tone: "success" });
    expect(getCollectionsBadgeView({ kind: "stopped", stopReason: null })).toEqual({ label: "Stopped", tone: "neutral" });
    expect(getCollectionsBadgeView({ kind: "paused", sequenceId: "x" })).toEqual({ label: "Paused", tone: "neutral" });
    expect(getCollectionsBadgeView({ kind: "blocked_uncertain", sequenceId: "x" })).toEqual({ label: "Blocked", tone: "warning" });
    expect(getCollectionsBadgeView({ kind: "active", sequenceId: "x", stepsCompleted: 1, stepCount: 4 })).toEqual({
      label: "Active",
      tone: "success",
    });
  });

  it("never leaks an internal enum name (e.g. blocked_uncertain) as the label", () => {
    const statuses: CollectionStatusView["kind"][] = ["completed", "stopped", "paused", "blocked_uncertain", "active"];
    for (const kind of statuses) {
      const view = getCollectionsBadgeView({ kind, sequenceId: "x", stopReason: null, stepsCompleted: 0, stepCount: 0 } as CollectionStatusView);
      expect(view?.label).not.toMatch(/_/);
      expect(view?.label).not.toBe(kind);
    }
  });
});

describe("getCollectionsBadgesForInvoices", () => {
  it("returns an empty map for an empty invoice id list without querying", async () => {
    expect(await getCollectionsBadgesForInvoices("org-does-not-matter", [])).toEqual(new Map());
  });

  it("returns no entry for an invoice never enrolled in collections", async () => {
    const { organization } = await createTestOrganization();
    const customer = await createCustomer(organization.id, { name: "Acme" });
    const invoice = await createInvoice(organization.id, {
      customerId: customer.id,
      number: "INV-0001",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2026-01-01",
      dueDate: "2026-01-15",
    });

    const badges = await getCollectionsBadgesForInvoices(organization.id, [invoice.id]);
    expect(badges.has(invoice.id)).toBe(false);
  });

  it("only returns badges for invoices actually passed in, scoped to the organization", async () => {
    const { organization: orgA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");
    const customerB = await createCustomer(orgB.id, { name: "Org B Customer" });
    const invoiceB = await createInvoice(orgB.id, {
      customerId: customerB.id,
      number: "INV-0001",
      currency: "USD",
      amountMinor: majorToMinor(100),
      issueDate: "2026-01-01",
      dueDate: "2026-01-15",
    });

    // Asking org A about org B's invoice id must never return org B's data.
    const badges = await getCollectionsBadgesForInvoices(orgA.id, [invoiceB.id]);
    expect(badges.size).toBe(0);
  });
});
