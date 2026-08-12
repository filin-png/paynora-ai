"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { createOrganization } from "@/server/tenancy/organizations";
import { requireUserForPage } from "@/server/tenancy/guards";

export type CreateOrganizationFormState = { error: string } | null;

export async function createOrganizationAction(
  _prevState: CreateOrganizationFormState,
  formData: FormData,
): Promise<CreateOrganizationFormState> {
  const user = await requireUserForPage();
  const name = String(formData.get("name") ?? "");

  let organization;
  try {
    organization = await createOrganization(user, name);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? "Invalid organization name." };
    }
    throw error;
  }

  redirect(`/app/${organization.slug}`);
}
