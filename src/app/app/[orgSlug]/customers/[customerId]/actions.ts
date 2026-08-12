"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { archiveCustomer, updateCustomer } from "@/server/ar/customers";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import type { CustomerFormState } from "../customer-form";

export async function archiveCustomerAction(orgSlug: string, customerId: string): Promise<void> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  await archiveCustomer(context.organization.id, customerId);
  revalidatePath(`/app/${orgSlug}/customers/${customerId}`);
  revalidatePath(`/app/${orgSlug}/customers`);
}

export async function updateCustomerAction(
  orgSlug: string,
  customerId: string,
  _prevState: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);

  try {
    await updateCustomer(context.organization.id, customerId, {
      name: String(formData.get("name") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      companyName: String(formData.get("companyName") ?? ""),
      notes: String(formData.get("notes") ?? ""),
      telegramChatId: String(formData.get("telegramChatId") ?? ""),
      preferredCommunicationChannel: String(formData.get("preferredCommunicationChannel") ?? "") as
        | "EMAIL"
        | "TELEGRAM"
        | "",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? "Invalid customer details." };
    }
    throw error;
  }

  revalidatePath(`/app/${orgSlug}/customers/${customerId}`);
  return null;
}
