"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { createCustomer } from "@/server/ar/customers";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";

export type CustomerFormState = { error: string } | null;

export async function createCustomerAction(
  orgSlug: string,
  _prevState: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);

  let customer;
  try {
    customer = await createCustomer(context.organization.id, {
      name: String(formData.get("name") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      companyName: String(formData.get("companyName") ?? ""),
      notes: String(formData.get("notes") ?? ""),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? "Invalid customer details." };
    }
    throw error;
  }

  redirect(`/app/${orgSlug}/customers/${customer.id}`);
}
