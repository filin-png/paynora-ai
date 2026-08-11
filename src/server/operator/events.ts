import { Prisma, type BusinessEvent } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { listInvoicesWithFinancials } from "@/server/ar/invoices";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export type DetectedBusinessEvent = {
  event: BusinessEvent;
  /** false when this event already existed from a previous detector run — see docs/operator-foundation.md#idempotency. */
  created: boolean;
};

/**
 * Deterministic, tenant-scoped, idempotent detector for the one Phase 3
 * event type. Reuses `listInvoicesWithFinancials`/`computeInvoiceFinancials`
 * (src/server/ar/invoices.ts) for the actual overdue determination — this
 * function only decides *what to do* with an already-computed fact, it
 * never recomputes financial state itself. Safe to call repeatedly (a cron
 * job, a manual "Run Operator" click, or both) — an invoice that's already
 * overdue from a prior run produces the same BusinessEvent row, not a
 * duplicate, because `dedupeKey` is the invoice id and
 * `[organizationId, type, dedupeKey]` is a DB-level unique constraint, not
 * just an application-level check.
 */
export async function detectInvoiceOverdueEvents(
  organizationId: string,
): Promise<DetectedBusinessEvent[]> {
  const overdueInvoices = await listInvoicesWithFinancials(organizationId, "overdue");
  const today = getBusinessToday();

  const results: DetectedBusinessEvent[] = [];
  for (const { invoice, financials } of overdueInvoices) {
    const dedupeKey = invoice.id;
    const dueDateStr = toDateOnlyString(invoice.dueDate);

    try {
      const event = await prisma.businessEvent.create({
        data: {
          organizationId,
          type: "INVOICE_OVERDUE",
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          dedupeKey,
          data: {
            invoiceNumber: invoice.number,
            currency: invoice.currency,
            amountMinor: financials.amountMinor.toString(),
            outstandingMinor: financials.outstandingMinor.toString(),
            dueDate: dueDateStr,
            daysOverdue: daysBetween(dueDateStr, today),
            detectedOn: today,
          },
        },
      });
      results.push({ event, created: true });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        const existing = await prisma.businessEvent.findUniqueOrThrow({
          where: {
            organizationId_type_dedupeKey: { organizationId, type: "INVOICE_OVERDUE", dedupeKey },
          },
        });
        results.push({ event: existing, created: false });
        continue;
      }
      throw error;
    }
  }

  return results;
}
