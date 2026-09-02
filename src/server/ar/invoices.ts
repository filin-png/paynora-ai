import { Prisma } from "@prisma/client";
import { z } from "zod";

import { trackEvent } from "@/server/analytics/events";
import { prisma } from "@/server/db/client";
import { assertWithinResourceLimit } from "@/server/billing/entitlements";
import { recordActivityEvent } from "./activity";
import { currencySchema } from "./currency";
import { dateOnlySchema, isPastDue, parseDateOnly } from "./dates";
import {
  ArResourceNotFoundError,
  DuplicateInvoiceNumberError,
  InvoiceHasPaymentsError,
} from "./errors";
import { amountMinorSchema, formatMoney } from "./money";
import { getCustomer } from "./customers";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export type LockedInvoiceRow = {
  id: string;
  organizationId: string;
  customerId: string;
  number: string;
  currency: string;
  amountMinor: bigint;
  status: "OPEN" | "CANCELLED";
};

/**
 * Locks the invoice row for the transaction's duration
 * (`SELECT ... FOR UPDATE`), tenant-scoped. Shared by every operation that
 * must serialize against concurrent changes to the same invoice —
 * `recordPayment` (payments.ts) and `cancelInvoice` below both use this,
 * which is what makes "an invoice can't end up CANCELLED with a payment
 * recorded against it" true regardless of which operation runs first: the
 * second one to reach this lock blocks until the first commits, then
 * re-reads the now-current state before deciding anything. See
 * docs/accounts-receivable.md#concurrency and
 * src/server/ar/invoices.test.ts for the cancel↔pay race test.
 */
export async function lockInvoiceForUpdate(
  tx: Prisma.TransactionClient,
  organizationId: string,
  invoiceId: string,
): Promise<LockedInvoiceRow> {
  const rows = await tx.$queryRaw<LockedInvoiceRow[]>`
    SELECT id, "organizationId", "customerId", number, currency, "amountMinor", status
    FROM invoices
    WHERE id = ${invoiceId} AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  const invoice = rows[0];
  if (!invoice) throw new ArResourceNotFoundError("Invoice");
  return invoice;
}

export const invoiceInputSchema = z
  .object({
    customerId: z.string().min(1, "Select a customer"),
    number: z.string().trim().min(1, "Invoice number is required").max(50),
    currency: currencySchema,
    amountMinor: amountMinorSchema,
    issueDate: dateOnlySchema,
    dueDate: dateOnlySchema,
    notes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((value) => (value ? value : undefined)),
  })
  .refine((data) => data.dueDate >= data.issueDate, {
    message: "Due date must be on or after the issue date",
    path: ["dueDate"],
  });

export type InvoiceInput = z.input<typeof invoiceInputSchema>;

export type InvoiceFinancials = {
  amountMinor: bigint;
  paidMinor: bigint;
  outstandingMinor: bigint;
  isPaid: boolean;
  isPartiallyPaid: boolean;
  isOverdue: boolean;
};

/**
 * The one place outstanding/paid amounts are computed from persisted
 * payments — never persisted themselves, so there is nothing to drift out
 * of sync. See docs/accounts-receivable.md#outstanding-balance.
 */
export function computeInvoiceFinancials(
  invoice: { amountMinor: bigint; dueDate: Date; status: "OPEN" | "CANCELLED" },
  paidMinor: bigint,
  today?: string,
): InvoiceFinancials {
  const rawOutstandingMinor = invoice.amountMinor - paidMinor;
  // Defense-in-depth, not the primary guarantee — see
  // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P2-2. recordPayment's own
  // OverpaymentError (src/server/ar/payments.ts) already prevents
  // paidMinor from ever exceeding amountMinor through the normal payment
  // path, so this should be unreachable. If it ever fires, something
  // bypassed that check (a bug, a manual DB edit, a migration issue) and
  // needs investigating. Logged loudly rather than either throwing here
  // (which would break every other invoice's list/detail view too, since
  // this pure function runs on every read path) or silently displaying a
  // negative "outstanding" balance to a user.
  if (rawOutstandingMinor < 0n) {
    console.error(
      `[invoices] financial invariant violated: paidMinor (${paidMinor}) exceeds amountMinor (${invoice.amountMinor}) — outstanding would be negative`,
    );
  }
  const outstandingMinor = rawOutstandingMinor < 0n ? 0n : rawOutstandingMinor;
  const isOpen = invoice.status === "OPEN";
  return {
    amountMinor: invoice.amountMinor,
    paidMinor,
    outstandingMinor,
    isPaid: isOpen && outstandingMinor <= 0n,
    isPartiallyPaid: isOpen && paidMinor > 0n && outstandingMinor > 0n,
    isOverdue: isOpen && outstandingMinor > 0n && isPastDue(invoice.dueDate, today),
  };
}

export async function getPaidMinorForInvoice(invoiceId: string): Promise<bigint> {
  const result = await prisma.payment.aggregate({
    where: { invoiceId },
    _sum: { amountMinor: true },
  });
  return result._sum.amountMinor ?? 0n;
}

export async function createInvoice(organizationId: string, rawInput: InvoiceInput) {
  const input = invoiceInputSchema.parse(rawInput);

  // Tenant-scoped: throws ArResourceNotFoundError for a customer id from
  // another organization exactly like one that doesn't exist at all.
  const customer = await getCustomer(organizationId, input.customerId);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await assertWithinResourceLimit(tx, organizationId, "invoices");

      const invoice = await tx.invoice.create({
        data: {
          organizationId,
          customerId: customer.id,
          number: input.number,
          currency: input.currency,
          amountMinor: input.amountMinor,
          issueDate: parseDateOnly(input.issueDate),
          dueDate: parseDateOnly(input.dueDate),
          notes: input.notes,
        },
      });
      await recordActivityEvent(tx, {
        organizationId,
        type: "INVOICE_CREATED",
        summary: `Invoice ${invoice.number} created for ${formatMoney(invoice.amountMinor, input.currency)}`,
        customerId: customer.id,
        invoiceId: invoice.id,
      });
      return invoice;
    });
    trackEvent("invoice_created", { organizationId, properties: { currency: input.currency } });
    return result;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_CONSTRAINT_VIOLATION
    ) {
      throw new DuplicateInvoiceNumberError();
    }
    throw error;
  }
}

export async function getInvoice(organizationId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    include: { customer: true },
  });
  if (!invoice) throw new ArResourceNotFoundError("Invoice");
  return invoice;
}

/**
 * `today`, added in Phase 5, lets a caller override "today" for the
 * overdue determination instead of the real server clock — used by the
 * collections automation engine (src/server/collections/engine.ts) so
 * runAutomationTick's date logic is genuinely deterministic relative to
 * its injected `now` parameter, not `new Date()`. Every other caller omits
 * it and gets the exact previous behavior (getBusinessToday(), via
 * isPastDue's own default parameter).
 */
export async function getInvoiceWithFinancials(organizationId: string, invoiceId: string, today?: string) {
  const invoice = await getInvoice(organizationId, invoiceId);
  const paidMinor = await getPaidMinorForInvoice(invoice.id);
  return { invoice, financials: computeInvoiceFinancials(invoice, paidMinor, today) };
}

export type InvoiceListFilter = "all" | "open" | "overdue" | "paid";

/**
 * `cursor`/`take` are opt-in — every existing caller that omits them
 * (the collections automation engine, sequence enrollment, overdue-event
 * detection, and the customer-detail page's per-customer invoice list)
 * keeps its exact previous unbounded behavior, which those callers
 * genuinely need (they must see every open/overdue invoice for the
 * organization, not one page of them). Only the main invoices list page
 * passes them, to bound that specific unbounded-growth risk — see
 * docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-6.
 *
 * Because `filter` is evaluated in-memory (open/overdue/paid all depend
 * on computed financials, not a stored column — see computeInvoiceFinancials
 * below), pagination happens on the *unfiltered* window: a page may return
 * fewer than `take` items when a narrow filter is active, exactly like any
 * "load more" list whose filter is applied after fetching a bounded page.
 * The cursor itself is still exact and gap-free — clicking "load more"
 * enough times always reaches every matching invoice.
 *
 * `invoiceIds`, added in Phase 16, narrows to a known set of invoices —
 * used by the attention-score bulk lookup (src/server/attention/for-invoices.ts)
 * so a caller that already knows which invoices it cares about (e.g. a
 * list of pending Action Center proposals) reuses this same query/financials
 * machinery instead of a second, parallel invoice-fetching path.
 */
export async function listInvoicesWithFinancials(
  organizationId: string,
  filter: InvoiceListFilter = "all",
  options: { customerId?: string; invoiceIds?: string[]; today?: string; cursor?: string; take?: number } = {},
) {
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId,
      ...(options.customerId ? { customerId: options.customerId } : {}),
      ...(options.invoiceIds ? { id: { in: options.invoiceIds } } : {}),
    },
    include: { customer: true },
    // `id` is a stable tiebreak — required for cursor pagination to never
    // skip or repeat a row when two invoices share an issueDate.
    orderBy: [{ issueDate: "desc" }, { id: "desc" }],
    ...(options.take != null ? { take: options.take } : {}),
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const sums = await prisma.payment.groupBy({
    by: ["invoiceId"],
    where: { invoiceId: { in: invoices.map((invoice) => invoice.id) } },
    _sum: { amountMinor: true },
  });
  const paidByInvoiceId = new Map(sums.map((sum) => [sum.invoiceId, sum._sum.amountMinor ?? 0n]));

  const withFinancials = invoices.map((invoice) => ({
    invoice,
    financials: computeInvoiceFinancials(invoice, paidByInvoiceId.get(invoice.id) ?? 0n, options.today),
  }));

  switch (filter) {
    case "open":
      return withFinancials.filter(
        ({ invoice, financials }) => invoice.status === "OPEN" && !financials.isPaid,
      );
    case "overdue":
      return withFinancials.filter(({ financials }) => financials.isOverdue);
    case "paid":
      return withFinancials.filter(({ financials }) => financials.isPaid);
    default:
      return withFinancials;
  }
}

/**
 * Locks the same invoice row recordPayment locks, and re-checks recorded
 * payments only after acquiring that lock — not from a pre-transaction
 * read. Without this, a payment recorded concurrently with a cancellation
 * could commit after cancelInvoice's initial (unlocked) check but before
 * its status update, leaving a CANCELLED invoice with a payment against
 * it. With both operations locking the same row, whichever transaction
 * commits first is the one that's true: a payment that lands first makes
 * the cancellation see paidMinor > 0 and reject; a cancellation that
 * lands first makes the payment see status CANCELLED and reject.
 */
export async function cancelInvoice(organizationId: string, invoiceId: string) {
  return prisma.$transaction(async (tx) => {
    const locked = await lockInvoiceForUpdate(tx, organizationId, invoiceId);

    if (locked.status !== "CANCELLED") {
      const paidAgg = await tx.payment.aggregate({
        where: { invoiceId: locked.id },
        _sum: { amountMinor: true },
      });
      const paidMinor = paidAgg._sum.amountMinor ?? 0n;
      if (paidMinor > 0n) throw new InvoiceHasPaymentsError();

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: "CANCELLED" },
      });
      await recordActivityEvent(tx, {
        organizationId,
        type: "INVOICE_CANCELLED",
        summary: `Invoice ${locked.number} cancelled`,
        customerId: locked.customerId,
        invoiceId: locked.id,
      });
    }

    return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  });
}
