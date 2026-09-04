import Papa from "papaparse";

import { prisma } from "@/server/db/client";
import type { Currency } from "./currency";
import { toDateOnlyString } from "./dates";
import { listInvoicesWithFinancials } from "./invoices";
import { minorToMajorString } from "./money";

/**
 * Phase 17 — data portability: an organization owner exporting their own
 * organization's AR records as CSV. This is a distinct concern from
 * src/server/auth/data-export.ts's "export my account data" (Phase 15A,
 * deliberately scoped to the requesting user's own account, explicitly
 * *not* organization financial records — see that file's doc comment).
 * That decision was about one member unilaterally pulling organization
 * data through a personal-privacy channel; this is the opposite: an
 * explicit, tenant-scoped export of records every member already sees
 * through the Invoices/Customers pages, reusing the same authorization
 * every other read in this codebase goes through
 * (requireOrganizationMembership at the API route, never bypassed here).
 *
 * Uses Papa.unparse (the same papaparse dependency CSV import already
 * uses, see src/server/ingestion/csv/parse.ts) rather than hand-joining
 * strings, so quoting/escaping of names or notes containing commas or
 * quotes is never a bug this code has to get right itself. Every export
 * passes an explicit `fields` list rather than letting Papa infer columns
 * from the first row — Papa.unparse([]) with no rows and no explicit
 * fields produces an empty string, so an organization with zero
 * customers/invoices/payments would otherwise download a literally
 * 0-byte file (which reads as "broken," not "no data yet") instead of a
 * proper header-only CSV.
 */

const CUSTOMER_FIELDS = [
  "id",
  "name",
  "email",
  "phone",
  "company_name",
  "telegram_chat_id",
  "preferred_channel",
  "archived",
  "archived_at",
  "created_at",
] as const;

export async function exportCustomersCsv(organizationId: string): Promise<string> {
  const customers = await prisma.customer.findMany({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
  });

  const rows = customers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    company_name: customer.companyName ?? "",
    telegram_chat_id: customer.telegramChatId ?? "",
    preferred_channel: customer.preferredCommunicationChannel ?? "",
    archived: customer.archivedAt ? "yes" : "no",
    archived_at: customer.archivedAt ? customer.archivedAt.toISOString() : "",
    created_at: customer.createdAt.toISOString(),
  }));

  return Papa.unparse({ fields: [...CUSTOMER_FIELDS], data: rows });
}

const INVOICE_FIELDS = [
  "id",
  "number",
  "customer_name",
  "currency",
  "amount",
  "outstanding",
  "status",
  "is_paid",
  "is_overdue",
  "issue_date",
  "due_date",
  "created_at",
] as const;

export async function exportInvoicesCsv(organizationId: string): Promise<string> {
  const invoices = await listInvoicesWithFinancials(organizationId, "all");

  const rows = invoices.map(({ invoice, financials }) => ({
    id: invoice.id,
    number: invoice.number,
    customer_name: invoice.customer.name,
    currency: invoice.currency,
    amount: minorToMajorString(financials.amountMinor),
    outstanding: minorToMajorString(financials.outstandingMinor),
    status: invoice.status,
    is_paid: financials.isPaid ? "yes" : "no",
    is_overdue: financials.isOverdue ? "yes" : "no",
    issue_date: toDateOnlyString(invoice.issueDate),
    due_date: toDateOnlyString(invoice.dueDate),
    created_at: invoice.createdAt.toISOString(),
  }));

  return Papa.unparse({ fields: [...INVOICE_FIELDS], data: rows });
}

const PAYMENT_FIELDS = [
  "id",
  "invoice_number",
  "customer_name",
  "currency",
  "amount",
  "paid_at",
  "note",
  "created_at",
] as const;

export async function exportPaymentsCsv(organizationId: string): Promise<string> {
  const payments = await prisma.payment.findMany({
    where: { organizationId },
    include: { invoice: { select: { number: true, currency: true, customer: { select: { name: true } } } } },
    orderBy: { paidAt: "asc" },
  });

  const rows = payments.map((payment) => ({
    id: payment.id,
    invoice_number: payment.invoice.number,
    customer_name: payment.invoice.customer.name,
    currency: payment.invoice.currency as Currency,
    amount: minorToMajorString(payment.amountMinor),
    paid_at: toDateOnlyString(payment.paidAt),
    note: payment.note ?? "",
    created_at: payment.createdAt.toISOString(),
  }));

  return Papa.unparse({ fields: [...PAYMENT_FIELDS], data: rows });
}
