"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import type { Currency } from "@/server/ar/currency";
import { createInvoice } from "@/server/ar/invoices";
import { parseAmountInput } from "@/server/ar/money";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";

export type InvoiceFormState = { error: string } | null;

export async function createInvoiceAction(
  orgSlug: string,
  _prevState: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);

  let amountMinor: bigint;
  try {
    amountMinor = parseAmountInput(String(formData.get("amount") ?? ""));
  } catch {
    return { error: "Enter a valid amount (up to 2 decimal places)." };
  }

  let invoice;
  try {
    invoice = await createInvoice(context.organization.id, {
      customerId: String(formData.get("customerId") ?? ""),
      number: String(formData.get("number") ?? ""),
      currency: String(formData.get("currency") ?? "") as Currency,
      amountMinor,
      issueDate: String(formData.get("issueDate") ?? ""),
      dueDate: String(formData.get("dueDate") ?? ""),
      notes: String(formData.get("notes") ?? ""),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? "Invalid invoice details." };
    }
    if (error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }

  redirect(`/app/${orgSlug}/invoices/${invoice.id}`);
}
