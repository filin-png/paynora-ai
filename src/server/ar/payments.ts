import { Prisma } from "@prisma/client";
import { z } from "zod";

import { trackEvent } from "@/server/analytics/events";
import { prisma } from "@/server/db/client";
import { recordActivityEvent } from "./activity";
import { dateOnlySchema, parseDateOnly } from "./dates";
import { InvoiceCancelledError, OverpaymentError } from "./errors";
import { lockInvoiceForUpdate } from "./invoices";
import { amountMinorSchema, formatMoney } from "./money";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export const paymentInputSchema = z.object({
  amountMinor: amountMinorSchema,
  paidAt: dateOnlySchema,
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => (value ? value : undefined)),
  // Phase 9: client-generated (e.g. crypto.randomUUID()) once per logical
  // submission and resubmitted unchanged on a retry — see
  // src/app/app/[orgSlug]/invoices/[invoiceId]/payment-form.tsx and
  // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-1. This is purely a
  // dedup token, never trusted as a financial fact: it decides whether to
  // return an existing Payment instead of creating a new one, never what
  // amount/date gets recorded. Optional with a random fallback so that
  // every *other* caller in this codebase (tests unrelated to idempotency,
  // any future non-interactive caller) doesn't need to invent one just to
  // record a payment — real deduplication only ever happens when a caller
  // deliberately reuses the same key, exactly as intended.
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .default(() => crypto.randomUUID()),
});

export type PaymentInput = z.input<typeof paymentInputSchema>;

/**
 * Records a payment with the invoice row locked for the transaction's
 * duration (`SELECT ... FOR UPDATE`, via lockInvoiceForUpdate — the same
 * lock cancelInvoice takes), so two concurrent payments against the same
 * invoice are serialized by Postgres rather than racing: the second
 * transaction blocks until the first commits, then re-reads the
 * now-current paid total before deciding whether it would overpay. This
 * is what makes overpayment rejection correct under concurrency, not just
 * in the common single-request case — see
 * docs/accounts-receivable.md#concurrency and
 * src/server/ar/payments.test.ts, which exercises this with two payments
 * fired at the same time. Locking against cancelInvoice specifically is
 * what prevents a payment from landing on an invoice that's being
 * cancelled concurrently — see src/server/ar/invoices.test.ts for that
 * race.
 *
 * Idempotent by `idempotencyKey` (Phase 9,
 * docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-1): the existing-payment
 * check happens *after* acquiring the invoice lock, so two concurrent
 * calls with the same key serialize through that same lock — the second
 * one blocks, then finds the first one's committed row and returns it
 * rather than creating a duplicate. `Payment.@@unique([invoiceId,
 * idempotencyKey])` is the actual database-level guarantee this relies
 * on; the lock-then-check above is what makes the expected case never
 * even attempt a conflicting insert. The `create` below is additionally
 * wrapped in a P2002 catch as defense-in-depth — the row lock should make
 * that branch unreachable in practice, but the unique constraint (not the
 * lock) is the thing actually guaranteeing correctness if that assumption
 * is ever wrong.
 *
 * Extracted from `recordPayment` (below) so a caller that must record a
 * payment atomically alongside its own other writes — Phase 13's wallet
 * reconciliation (src/server/wallet/reconciliation.ts) is the first — can
 * pass in its own already-open `tx` instead of this opening a second,
 * unrelated transaction (Prisma's interactive transactions don't nest).
 * `recordPayment` is unchanged behavior: it only parses input and opens
 * the transaction.
 */
export async function recordPaymentInTransaction(
  tx: Prisma.TransactionClient,
  organizationId: string,
  invoiceId: string,
  input: z.output<typeof paymentInputSchema>,
) {
  const invoice = await lockInvoiceForUpdate(tx, organizationId, invoiceId);

  const existing = await tx.payment.findUnique({
    where: {
      invoiceId_idempotencyKey: {
        invoiceId: invoice.id,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) return existing;

  if (invoice.status === "CANCELLED") throw new InvoiceCancelledError();

  const paidAgg = await tx.payment.aggregate({
    where: { invoiceId: invoice.id },
    _sum: { amountMinor: true },
  });
  const paidSoFar = paidAgg._sum.amountMinor ?? 0n;
  const outstandingMinor = invoice.amountMinor - paidSoFar;

  if (input.amountMinor > outstandingMinor) {
    throw new OverpaymentError(outstandingMinor);
  }

  let payment;
  try {
    payment = await tx.payment.create({
      data: {
        organizationId,
        invoiceId: invoice.id,
        amountMinor: input.amountMinor,
        paidAt: parseDateOnly(input.paidAt),
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_CONSTRAINT_VIOLATION
    ) {
      const raced = await tx.payment.findUniqueOrThrow({
        where: {
          invoiceId_idempotencyKey: {
            invoiceId: invoice.id,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      return raced;
    }
    throw error;
  }

  const currency = invoice.currency as Parameters<typeof formatMoney>[1];
  await recordActivityEvent(tx, {
    organizationId,
    type: "PAYMENT_RECORDED",
    summary: `Payment of ${formatMoney(payment.amountMinor, currency)} recorded for invoice ${invoice.number}`,
    customerId: invoice.customerId,
    invoiceId: invoice.id,
    metadata: { amountMinor: payment.amountMinor.toString() },
  });

  const remainingAfterPayment = outstandingMinor - input.amountMinor;
  if (remainingAfterPayment <= 0n) {
    await recordActivityEvent(tx, {
      organizationId,
      type: "INVOICE_PAID",
      summary: `Invoice ${invoice.number} fully paid`,
      customerId: invoice.customerId,
      invoiceId: invoice.id,
    });
  }

  return payment;
}

export async function recordPayment(
  organizationId: string,
  invoiceId: string,
  rawInput: PaymentInput,
) {
  const input = paymentInputSchema.parse(rawInput);
  const payment = await prisma.$transaction((tx) =>
    recordPaymentInTransaction(tx, organizationId, invoiceId, input),
  );
  trackEvent("payment_recorded", { organizationId });
  return payment;
}

export async function listPaymentsForInvoice(
  organizationId: string,
  invoiceId: string,
) {
  return prisma.payment.findMany({
    where: { organizationId, invoiceId },
    orderBy: { paidAt: "desc" },
    // Defensive cap, not real pagination — see
    // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P2-3. Payments per
    // single invoice are naturally self-limiting (bounded by how many
    // partial payments one invoice realistically gets); this only
    // guards the pathological case.
    take: 500,
  });
}
