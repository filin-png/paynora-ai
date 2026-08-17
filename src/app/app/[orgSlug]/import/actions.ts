"use server";

import { revalidatePath } from "next/cache";

import { parseCustomerCsv } from "@/server/ingestion/csv/customers";
import { parseInvoiceCsv } from "@/server/ingestion/csv/invoices";
import { importCustomers } from "@/server/ingestion/customers";
import { importInvoices } from "@/server/ingestion/invoices";
import { MAX_IMPORT_FILE_SIZE_BYTES } from "@/server/ingestion/limits";
import type { ImportOutcome } from "@/server/ingestion/types";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";

export type ImportFormState = ImportOutcome | null;

/**
 * Reads and bounds-checks the uploaded file before any parsing happens —
 * untrusted input, so size/type are checked before its content is even
 * decoded. Never persists the file; the returned text lives only for the
 * duration of this request.
 */
async function readCsvFile(formData: FormData): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, reason: "Choose a CSV file to import." };
  }
  if (file.size > MAX_IMPORT_FILE_SIZE_BYTES) {
    return {
      ok: false,
      reason: `File is too large — the limit is ${Math.floor(MAX_IMPORT_FILE_SIZE_BYTES / (1024 * 1024))} MB.`,
    };
  }
  const name = file.name.toLowerCase();
  const looksLikeCsv = name.endsWith(".csv") || file.type === "text/csv" || file.type === "application/vnd.ms-excel";
  if (!looksLikeCsv) {
    return { ok: false, reason: "Only .csv files are supported." };
  }
  const text = await file.text();
  return { ok: true, text };
}

export async function importCustomersAction(
  orgSlug: string,
  _prevState: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);

  const read = await readCsvFile(formData);
  if (!read.ok) return { kind: "rejected", reason: read.reason };

  const parsed = parseCustomerCsv(read.text);
  if (!parsed.ok) return { kind: "rejected", reason: parsed.reason };

  const summary = await importCustomers(context.organization.id, parsed.records);
  if (summary.created > 0) revalidatePath(`/app/${orgSlug}/customers`);
  return { kind: "completed", summary };
}

export async function importInvoicesAction(
  orgSlug: string,
  _prevState: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);

  const read = await readCsvFile(formData);
  if (!read.ok) return { kind: "rejected", reason: read.reason };

  const parsed = parseInvoiceCsv(read.text);
  if (!parsed.ok) return { kind: "rejected", reason: parsed.reason };

  const summary = await importInvoices(context.organization.id, parsed.records);
  if (summary.created > 0) revalidatePath(`/app/${orgSlug}/invoices`);
  return { kind: "completed", summary };
}
