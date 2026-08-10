"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { cancelInvoice } from "@/server/ar/invoices";
import { parseAmountInput } from "@/server/ar/money";
import { recordPayment } from "@/server/ar/payments";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";

export type PaymentFormState = { error: string } | null;

export async function recordPaymentAction(
  orgSlug: string,
  invoiceId: string,
  _prevState: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);

  let amountMinor: bigint;
  try {
    amountMinor = parseAmountInput(String(formData.get("amount") ?? ""));
  } catch {
    return { error: "Enter a valid amount (up to 2 decimal places)." };
  }

  try {
    await recordPayment(context.organization.id, invoiceId, {
      amountMinor,
      paidAt: String(formData.get("paidAt") ?? ""),
      note: String(formData.get("note") ?? ""),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? "Invalid payment details." };
    }
    if (error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/app/${orgSlug}/invoices/${invoiceId}`);
  revalidatePath(`/app/${orgSlug}`);
  return null;
}

export async function cancelInvoiceAction(orgSlug: string, invoiceId: string): Promise<void> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  await cancelInvoice(context.organization.id, invoiceId);
  revalidatePath(`/app/${orgSlug}/invoices/${invoiceId}`);
  revalidatePath(`/app/${orgSlug}`);
}
