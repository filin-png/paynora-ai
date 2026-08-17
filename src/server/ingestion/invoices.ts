import { z } from "zod";

import { toDateOnlyString } from "@/server/ar/dates";
import { createInvoice, invoiceInputSchema } from "@/server/ar/invoices";
import { DuplicateInvoiceNumberError } from "@/server/ar/errors";
import { parseAmountInput } from "@/server/ar/money";
import { EntitlementLimitExceededError } from "@/server/billing/entitlements";
import { prisma } from "@/server/db/client";
import { MAX_IMPORT_ROWS } from "./limits";
import type { ImportSummary, NormalizedInvoiceRecord } from "./types";
import { summarizeRows } from "./types";

/**
 * The source-neutral half of invoice ingestion — see `customers.ts`'s
 * equivalent doc comment for the overall shape of this. Reuses
 * `invoiceInputSchema` and `createInvoice` exactly as the manual "New
 * invoice" form does — currency allowlist, positive/max amount,
 * `dueDate >= issueDate`, and the `(organizationId, number)` uniqueness
 * constraint are all enforced by the *same* code the form uses, not
 * reimplemented here.
 *
 * Duplicate/conflict behavior (documented, not merely implicit): an
 * invoice number that already exists in this organization — either in the
 * database already, or earlier in this same file — is never overwritten.
 * If the existing invoice's customer/currency/amount/dates match the
 * imported row exactly, the row is `skipped` (the same file imported
 * twice is idempotent). If they differ, the row is `failed` with an
 * explicit conflict message — silently keeping the old data is the
 * correct choice for a financial record; silently applying the new data
 * would be worse.
 */
export async function importInvoices(
  organizationId: string,
  records: NormalizedInvoiceRecord[],
): Promise<ImportSummary> {
  if (records.length > MAX_IMPORT_ROWS) {
    throw new Error(`Cannot import more than ${MAX_IMPORT_ROWS} rows at once.`);
  }

  const candidateEmails = Array.from(
    new Set(records.map((record) => record.customerEmail.toLowerCase()).filter((email) => email.length > 0)),
  );
  const candidateCustomers =
    candidateEmails.length > 0
      ? await prisma.customer.findMany({
          where: { organizationId, email: { in: candidateEmails } },
          select: { id: true, email: true },
        })
      : [];
  const customersByEmail = new Map<string, { id: string }[]>();
  for (const customer of candidateCustomers) {
    if (!customer.email) continue;
    const key = customer.email.toLowerCase();
    const bucket = customersByEmail.get(key) ?? [];
    bucket.push(customer);
    customersByEmail.set(key, bucket);
  }

  const candidateNumbers = Array.from(new Set(records.map((record) => record.invoiceNumber.trim()).filter(Boolean)));
  const existingInvoices =
    candidateNumbers.length > 0
      ? await prisma.invoice.findMany({
          where: { organizationId, number: { in: candidateNumbers } },
        })
      : [];
  const existingByNumber = new Map(existingInvoices.map((invoice) => [invoice.number, invoice]));

  const rows: ImportSummary["rows"] = [];
  const seenNumbersInFile = new Map<string, number>();
  // Section 7 ("bulk import limit safety") — see the identical mechanism
  // in src/server/ingestion/customers.ts#importCustomers for the full
  // reasoning: once the organization's open-invoice quota is hit, every
  // remaining row that would attempt a genuinely new create fails
  // immediately without another doomed createInvoice call. Skipped
  // (identical re-import) and failed (conflict/validation) rows above
  // never reach this point, so they never consume quota either way.
  let quotaExhausted = false;

  for (const record of records) {
    if (record.sourceError) {
      rows.push({ sourceRow: record.sourceRow, status: "failed", message: `Malformed row: ${record.sourceError}` });
      continue;
    }

    const number = record.invoiceNumber.trim();
    if (!number) {
      rows.push({ sourceRow: record.sourceRow, status: "failed", message: "Missing invoice number", field: "invoiceNumber" });
      continue;
    }
    if (seenNumbersInFile.has(number)) {
      rows.push({
        sourceRow: record.sourceRow,
        status: "failed",
        message: `Duplicate invoice number "${number}" also appears at row ${seenNumbersInFile.get(number)} in this file`,
        field: "invoiceNumber",
      });
      continue;
    }
    seenNumbersInFile.set(number, record.sourceRow);

    const emailKey = record.customerEmail.toLowerCase();
    if (!emailKey) {
      rows.push({ sourceRow: record.sourceRow, status: "failed", message: "Missing customer email", field: "customerEmail" });
      continue;
    }
    const matchedCustomers = customersByEmail.get(emailKey) ?? [];
    if (matchedCustomers.length === 0) {
      rows.push({
        sourceRow: record.sourceRow,
        status: "failed",
        message: `No customer found with email "${record.customerEmail}" — import that customer first`,
        field: "customerEmail",
      });
      continue;
    }
    if (matchedCustomers.length > 1) {
      rows.push({
        sourceRow: record.sourceRow,
        status: "failed",
        message: `Multiple customers in this organization share the email "${record.customerEmail}" — cannot determine which one to use`,
        field: "customerEmail",
      });
      continue;
    }
    const customer = matchedCustomers[0]!;

    let amountMinor: bigint;
    try {
      amountMinor = parseAmountInput(record.amount);
    } catch (error) {
      rows.push({
        sourceRow: record.sourceRow,
        status: "failed",
        message: error instanceof Error ? error.message : "Invalid amount",
        field: "amount",
      });
      continue;
    }

    const parsedInput = invoiceInputSchema.safeParse({
      customerId: customer.id,
      number,
      currency: record.currency.toUpperCase(),
      amountMinor,
      issueDate: record.issueDate,
      dueDate: record.dueDate,
    });
    if (!parsedInput.success) {
      const issue: z.ZodIssue = parsedInput.error.issues[0]!;
      rows.push({
        sourceRow: record.sourceRow,
        status: "failed",
        message: issue.message,
        field: String(issue.path[0] ?? ""),
      });
      continue;
    }

    const existing = existingByNumber.get(number);
    if (existing) {
      const identical =
        existing.customerId === customer.id &&
        existing.currency === parsedInput.data.currency &&
        existing.amountMinor === parsedInput.data.amountMinor &&
        toDateOnlyString(existing.issueDate) === parsedInput.data.issueDate &&
        toDateOnlyString(existing.dueDate) === parsedInput.data.dueDate;
      if (identical) {
        rows.push({
          sourceRow: record.sourceRow,
          status: "skipped",
          message: `Invoice "${number}" already exists with identical data — not imported again`,
        });
      } else {
        rows.push({
          sourceRow: record.sourceRow,
          status: "failed",
          message: `Invoice "${number}" already exists with different data — not overwritten`,
          field: "invoiceNumber",
        });
      }
      continue;
    }

    if (quotaExhausted) {
      rows.push({
        sourceRow: record.sourceRow,
        status: "failed",
        message: "Organization's plan open-invoice limit reached — not imported. Remaining rows are also skipped for the same reason.",
        field: "invoiceNumber",
      });
      continue;
    }

    try {
      const invoice = await createInvoice(organizationId, parsedInput.data);
      rows.push({ sourceRow: record.sourceRow, status: "created", message: `Created invoice "${invoice.number}"` });
    } catch (error) {
      // The bulk pre-check above can't see a write that lands between that
      // check and this call — a concurrent import racing this one for the
      // same number. createInvoice's own unique-constraint handling still
      // protects the data; report it exactly like a pre-existing conflict
      // rather than a generic failure.
      if (error instanceof DuplicateInvoiceNumberError) {
        rows.push({
          sourceRow: record.sourceRow,
          status: "failed",
          message: `Invoice "${number}" was just created by a concurrent import — not imported again`,
          field: "invoiceNumber",
        });
      } else if (error instanceof EntitlementLimitExceededError) {
        quotaExhausted = true;
        rows.push({ sourceRow: record.sourceRow, status: "failed", message: error.message, field: "invoiceNumber" });
      } else {
        rows.push({ sourceRow: record.sourceRow, status: "failed", message: "Failed to create invoice" });
      }
    }
  }

  return summarizeRows(records.length, rows);
}
