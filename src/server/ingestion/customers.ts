import { z } from "zod";

import { createCustomer } from "@/server/ar/customers";
import { prisma } from "@/server/db/client";
import { MAX_IMPORT_ROWS } from "./limits";
import type { ImportSummary, NormalizedCustomerRecord } from "./types";
import { summarizeRows } from "./types";

/**
 * The source-neutral half of customer ingestion — takes normalized
 * records (CSV today; anything else later, see `types.ts`) and does
 * validation + the actual write. Reuses `createCustomer` exactly as the
 * manual "New customer" form does, so an imported customer is completely
 * indistinguishable from a manually-created one — same `customerInputSchema`
 * validation, same `CUSTOMER_CREATED` activity event, same tenant scoping.
 *
 * Duplicate behavior (documented, not merely implicit): a customer is
 * considered "the same" as an existing one when its email (normalized —
 * trimmed, lowercased) matches, either an existing DB row or an earlier
 * row already processed from this same file. A match is always skipped,
 * never overwritten — this import path never updates an existing
 * customer's fields. A customer row with no email can never be matched
 * against anything and is always created; this is an accepted, documented
 * limitation of not having a stable external customer identifier in the
 * current schema (see docs/data-ingestion.md#customer-matching).
 */
export async function importCustomers(
  organizationId: string,
  records: NormalizedCustomerRecord[],
): Promise<ImportSummary> {
  if (records.length > MAX_IMPORT_ROWS) {
    throw new Error(`Cannot import more than ${MAX_IMPORT_ROWS} rows at once.`);
  }

  const candidateEmails = Array.from(
    new Set(records.map((record) => record.email.toLowerCase()).filter((email) => email.length > 0)),
  );
  const existingCustomers =
    candidateEmails.length > 0
      ? await prisma.customer.findMany({
          where: { organizationId, email: { in: candidateEmails } },
          select: { email: true },
        })
      : [];
  const existingEmails = new Set(
    existingCustomers.map((customer) => customer.email?.toLowerCase()).filter((email): email is string => !!email),
  );

  const rows: ImportSummary["rows"] = [];
  const seenEmailsInFile = new Map<string, number>();

  for (const record of records) {
    if (record.sourceError) {
      rows.push({ sourceRow: record.sourceRow, status: "failed", message: `Malformed row: ${record.sourceError}` });
      continue;
    }

    const emailKey = record.email.toLowerCase();

    if (emailKey && seenEmailsInFile.has(emailKey)) {
      rows.push({
        sourceRow: record.sourceRow,
        status: "skipped",
        message: `Duplicate of row ${seenEmailsInFile.get(emailKey)} in this file (same email) — not imported again`,
        field: "email",
      });
      continue;
    }

    if (emailKey && existingEmails.has(emailKey)) {
      seenEmailsInFile.set(emailKey, record.sourceRow);
      rows.push({
        sourceRow: record.sourceRow,
        status: "skipped",
        message: "A customer with this email already exists in this organization — not modified",
        field: "email",
      });
      continue;
    }

    try {
      const customer = await createCustomer(organizationId, {
        name: record.name,
        email: record.email || undefined,
        phone: record.phone || undefined,
      });
      if (emailKey) seenEmailsInFile.set(emailKey, record.sourceRow);
      rows.push({ sourceRow: record.sourceRow, status: "created", message: `Created customer "${customer.name}"` });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issue = error.issues[0]!;
        rows.push({
          sourceRow: record.sourceRow,
          status: "failed",
          message: issue.message,
          field: String(issue.path[0] ?? ""),
        });
      } else {
        rows.push({ sourceRow: record.sourceRow, status: "failed", message: "Failed to create customer" });
      }
    }
  }

  return summarizeRows(records.length, rows);
}
