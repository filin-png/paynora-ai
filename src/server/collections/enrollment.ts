import { Prisma, type CollectionSequence } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { listInvoicesWithFinancials } from "@/server/ar/invoices";
import { prisma } from "@/server/db/client";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export type EnsuredSequence = { sequence: CollectionSequence; created: boolean };

/**
 * Idempotent: a second call for the same invoice finds the existing
 * CollectionSequence via the unique constraint on [organizationId,
 * invoiceId] instead of creating a duplicate — the same create-then-catch-
 * P2002 pattern as every other Phase 3/4 idempotent creation
 * (src/server/operator/events.ts, src/server/operator/proposals.ts,
 * src/server/communications/draft.ts). Locks in the enrolling policy's
 * *current* version at the moment of enrollment
 * (CollectionSequence.policyVersion) so later edits to the policy's steps
 * never retroactively change this sequence's behavior — see
 * prisma/schema.prisma's CollectionSequence doc comment.
 */
export async function enrollInvoice(
  organizationId: string,
  invoiceId: string,
  customerId: string,
  policyId: string,
  policyVersion: number,
): Promise<EnsuredSequence> {
  try {
    const sequence = await prisma.$transaction(async (tx) => {
      const created = await tx.collectionSequence.create({
        data: { organizationId, invoiceId, customerId, policyId, policyVersion, status: "ACTIVE" },
      });
      await recordActivityEvent(tx, {
        organizationId,
        type: "COLLECTION_SEQUENCE_STARTED",
        summary: "Invoice enrolled into collections automation",
        invoiceId,
        customerId,
      });
      return created;
    });
    return { sequence, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
      const existing = await prisma.collectionSequence.findUniqueOrThrow({
        where: { organizationId_invoiceId: { organizationId, invoiceId } },
      });
      return { sequence: existing, created: false };
    }
    throw error;
  }
}

/**
 * Lazily enrolls every eligible OPEN invoice for an organization that
 * doesn't already have a sequence — called once per tick by the automation
 * engine (src/server/collections/engine.ts), not by a per-invoice cron row
 * or an invoice-creation hook. This is what lets bulk-imported invoices (a
 * documented future need — see docs/collections-automation.md#scaling)
 * enroll automatically on the next tick with no special-casing, and what
 * keeps enrollment idempotent under concurrent ticks (each individual
 * enrollInvoice call is its own idempotent create). "Eligible" here only
 * means OPEN + not fully paid + customer not archived — it does NOT
 * require the invoice to already be overdue; a sequence can exist for a
 * not-yet-due invoice, it just won't have any due step yet.
 *
 * Bulk-fetches invoices + payment sums via listInvoicesWithFinancials (two
 * queries total, not one per invoice) and the set of already-enrolled
 * invoice ids (one more query) — see docs/collections-automation.md
 * #performance for why this avoids the N+1 pattern the per-invoice writes
 * that follow can't otherwise avoid.
 */
export async function enrollEligibleInvoices(
  organizationId: string,
  policyId: string,
  policyVersion: number,
  today?: string,
): Promise<EnsuredSequence[]> {
  const openInvoices = await listInvoicesWithFinancials(organizationId, "open", { today });
  if (openInvoices.length === 0) return [];

  const alreadyEnrolled = await prisma.collectionSequence.findMany({
    where: { organizationId, invoiceId: { in: openInvoices.map(({ invoice }) => invoice.id) } },
    select: { invoiceId: true },
  });
  const enrolledIds = new Set(alreadyEnrolled.map((row) => row.invoiceId));

  const results: EnsuredSequence[] = [];
  for (const { invoice } of openInvoices) {
    if (enrolledIds.has(invoice.id)) continue;
    if (invoice.customer.archivedAt) continue;
    results.push(await enrollInvoice(organizationId, invoice.id, invoice.customerId, policyId, policyVersion));
  }
  return results;
}
