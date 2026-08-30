import { Prisma, type BusinessEvent } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { listInvoicesWithFinancials } from "@/server/ar/invoices";
import { getAllCustomerPaymentTrends } from "@/server/customer-intelligence/trends";
import { computeOverduePriority } from "./insights";

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

/**
 * Shared create-or-find-existing helper for the Phase 16 detectors below —
 * the exact same idempotency pattern as `detectInvoiceOverdueEvents` above
 * (a DB unique constraint on `[organizationId, type, dedupeKey]`, never
 * just an in-memory check), factored out so three new detectors don't each
 * repeat the same try/catch.
 */
async function ensureBusinessEvent(
  organizationId: string,
  type: BusinessEvent["type"],
  dedupeKey: string,
  data: {
    customerId?: string | null;
    invoiceId?: string | null;
    data: Prisma.InputJsonValue;
  },
): Promise<DetectedBusinessEvent> {
  try {
    const event = await prisma.businessEvent.create({
      data: {
        organizationId,
        type,
        customerId: data.customerId ?? null,
        invoiceId: data.invoiceId ?? null,
        dedupeKey,
        data: data.data,
      },
    });
    return { event, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
      const existing = await prisma.businessEvent.findUniqueOrThrow({
        where: { organizationId_type_dedupeKey: { organizationId, type, dedupeKey } },
      });
      return { event: existing, created: false };
    }
    throw error;
  }
}

/**
 * Phase 16 — a good-news, insight-only event (see
 * ensureInsightForPaymentReceivedEvent in insights.ts; never produces an
 * ActionProposal, there is nothing to approve about money that already
 * arrived). Deduped one-per-Payment via `dedupeKey = payment.id`, so
 * recording one payment can never generate more than one event, no matter
 * how many times this detector runs.
 *
 * Bounded to payments recorded in the last `lookbackDays` (default 2,
 * covering "yesterday and today" so a detector run that's briefly delayed
 * or run more than once a day never misses one) — unlike
 * `detectInvoiceOverdueEvents`, which can safely re-scan "still overdue"
 * forever because that set is naturally bounded, the set of *all* payments
 * ever recorded grows without bound, so scanning it in full on every run
 * would be an unbounded-cost query. See
 * docs/proactive-financial-operations.md#business-events.
 */
export async function detectPaymentReceivedEvents(
  organizationId: string,
  lookbackDays = 2,
): Promise<DetectedBusinessEvent[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - lookbackDays);

  const payments = await prisma.payment.findMany({
    where: { organizationId, createdAt: { gte: since } },
    include: { invoice: true },
  });

  const results: DetectedBusinessEvent[] = [];
  for (const payment of payments) {
    const result = await ensureBusinessEvent(organizationId, "PAYMENT_RECEIVED", payment.id, {
      customerId: payment.invoice.customerId,
      invoiceId: payment.invoiceId,
      data: {
        invoiceNumber: payment.invoice.number,
        currency: payment.invoice.currency,
        amountMinor: payment.amountMinor.toString(),
        paidAt: toDateOnlyString(payment.paidAt),
      },
    });
    results.push(result);
  }
  return results;
}

/**
 * Phase 16 — fires when an already-overdue invoice crosses into a higher
 * severity bucket for the first time, reusing `computeOverduePriority`
 * (insights.ts) so the buckets are always the exact same MEDIUM/HIGH
 * thresholds the rest of the Operator already uses — never a second,
 * divergent definition of risk. Deduped per invoice+bucket
 * (`dedupeKey = "<invoiceId>:<bucket>"`), so an invoice sitting at HIGH
 * for weeks fires this exactly once; it fires again only when it later
 * crosses into a *new* bucket. Deliberately insight-only: the original
 * INVOICE_OVERDUE event already has its own SEND_PAYMENT_REMINDER
 * proposal (created once, still PENDING until a human decides) —
 * escalation raises that invoice's attention score and appears in "what
 * changed," it does not create a second, redundant reminder proposal for
 * the same invoice. LOW-priority invoices never reach here (nothing to
 * escalate to yet).
 */
export async function detectInvoiceRiskEscalationEvents(
  organizationId: string,
): Promise<DetectedBusinessEvent[]> {
  const overdueInvoices = await listInvoicesWithFinancials(organizationId, "overdue");
  const today = getBusinessToday();

  const results: DetectedBusinessEvent[] = [];
  for (const { invoice, financials } of overdueInvoices) {
    const dueDateStr = toDateOnlyString(invoice.dueDate);
    const daysOverdue = daysBetween(dueDateStr, today);
    const bucket = computeOverduePriority(daysOverdue);
    if (bucket === "LOW") continue;

    const dedupeKey = `${invoice.id}:${bucket}`;
    const result = await ensureBusinessEvent(organizationId, "INVOICE_RISK_ESCALATED", dedupeKey, {
      customerId: invoice.customerId,
      invoiceId: invoice.id,
      data: {
        invoiceNumber: invoice.number,
        currency: invoice.currency,
        outstandingMinor: financials.outstandingMinor.toString(),
        daysOverdue,
        bucket,
      },
    });
    results.push(result);
  }
  return results;
}

/** Deterministic "which calendar week" bucket for dedupeKey use only — not a display value. */
function weekBucketFor(dateStr: string): string {
  const epochDay = Math.floor(Date.parse(`${dateStr}T00:00:00.000Z`) / 86_400_000);
  return String(Math.floor(epochDay / 7));
}

/**
 * Phase 16 — fires when a customer's recent payment-delay trend has
 * deteriorated materially versus their own prior history (see
 * getAllCustomerPaymentTrends, src/server/customer-intelligence/trends.ts,
 * for the deterministic "improving"/"deteriorating"/"stable" decision —
 * this detector never invents a trend for a customer with insufficient
 * history). Insight-only, same reasoning as risk escalation above: there
 * is no customer-level ActionType in the allowlist yet
 * (SEND_PAYMENT_REMINDER is invoice-scoped), so this raises visibility —
 * Daily Brief, customer detail, attention ranking — without fabricating an
 * action to propose. Deduped per customer+calendar-week, so a detector run
 * multiple times in the same week for a customer whose trend hasn't
 * changed produces one event, not one per run.
 */
export async function detectCustomerBehaviorDeterioratedEvents(
  organizationId: string,
): Promise<DetectedBusinessEvent[]> {
  const trends = await getAllCustomerPaymentTrends(organizationId);
  const today = getBusinessToday();
  const week = weekBucketFor(today);

  const results: DetectedBusinessEvent[] = [];
  for (const [customerId, trend] of trends) {
    if (trend.status !== "deteriorating") continue;

    const dedupeKey = `${customerId}:${week}`;
    const result = await ensureBusinessEvent(organizationId, "CUSTOMER_PAYMENT_BEHAVIOR_DETERIORATED", dedupeKey, {
      customerId,
      invoiceId: null,
      data: {
        recentAvgDelayDays: trend.recentAvgDelayDays,
        previousAvgDelayDays: trend.previousAvgDelayDays,
        deltaDays: trend.deltaDays,
        detectedOn: today,
      },
    });
    results.push(result);
  }
  return results;
}
