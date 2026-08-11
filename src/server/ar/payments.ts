import { z } from "zod";

import { prisma } from "@/server/db/client";
import { recordActivityEvent } from "./activity";
import { dateOnlySchema, parseDateOnly } from "./dates";
import { InvoiceCancelledError, OverpaymentError } from "./errors";
import { lockInvoiceForUpdate } from "./invoices";
import { amountMinorSchema, formatMoney } from "./money";

export const paymentInputSchema = z.object({
  amountMinor: amountMinorSchema,
  paidAt: dateOnlySchema,
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => (value ? value : undefined)),
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
 */
export async function recordPayment(
  organizationId: string,
  invoiceId: string,
  rawInput: PaymentInput,
) {
  const input = paymentInputSchema.parse(rawInput);

  return prisma.$transaction(async (tx) => {
    const invoice = await lockInvoiceForUpdate(tx, organizationId, invoiceId);
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

    const payment = await tx.payment.create({
      data: {
        organizationId,
        invoiceId: invoice.id,
        amountMinor: input.amountMinor,
        paidAt: parseDateOnly(input.paidAt),
        note: input.note,
      },
    });

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
  });
}

export async function listPaymentsForInvoice(organizationId: string, invoiceId: string) {
  return prisma.payment.findMany({
    where: { organizationId, invoiceId },
    orderBy: { paidAt: "desc" },
  });
}
