import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/server/db/client";
import { recordActivityEvent } from "./activity";
import { currencySchema } from "./currency";
import { dateOnlySchema, isPastDue, parseDateOnly } from "./dates";
import { ArResourceNotFoundError, DuplicateInvoiceNumberError } from "./errors";
import { amountMinorSchema, formatMoney } from "./money";
import { getCustomer } from "./customers";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

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
  const outstandingMinor = invoice.amountMinor - paidMinor;
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
    return await prisma.$transaction(async (tx) => {
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

export async function getInvoiceWithFinancials(organizationId: string, invoiceId: string) {
  const invoice = await getInvoice(organizationId, invoiceId);
  const paidMinor = await getPaidMinorForInvoice(invoice.id);
  return { invoice, financials: computeInvoiceFinancials(invoice, paidMinor) };
}

export type InvoiceListFilter = "all" | "open" | "overdue" | "paid";

export async function listInvoicesWithFinancials(
  organizationId: string,
  filter: InvoiceListFilter = "all",
  options: { customerId?: string } = {},
) {
  const invoices = await prisma.invoice.findMany({
    where: { organizationId, ...(options.customerId ? { customerId: options.customerId } : {}) },
    include: { customer: true },
    orderBy: { issueDate: "desc" },
  });

  const sums = await prisma.payment.groupBy({
    by: ["invoiceId"],
    where: { invoiceId: { in: invoices.map((invoice) => invoice.id) } },
    _sum: { amountMinor: true },
  });
  const paidByInvoiceId = new Map(sums.map((sum) => [sum.invoiceId, sum._sum.amountMinor ?? 0n]));

  const withFinancials = invoices.map((invoice) => ({
    invoice,
    financials: computeInvoiceFinancials(invoice, paidByInvoiceId.get(invoice.id) ?? 0n),
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

export async function cancelInvoice(organizationId: string, invoiceId: string) {
  const { invoice, financials } = await getInvoiceWithFinancials(organizationId, invoiceId);
  if (invoice.status === "CANCELLED") return invoice;
  if (financials.paidMinor > 0n) {
    throw new Error("Cannot cancel an invoice that has recorded payments");
  }

  return prisma.$transaction(async (tx) => {
    const cancelled = await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: "CANCELLED" },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "INVOICE_CANCELLED",
      summary: `Invoice ${cancelled.number} cancelled`,
      customerId: cancelled.customerId,
      invoiceId: cancelled.id,
    });
    return cancelled;
  });
}
