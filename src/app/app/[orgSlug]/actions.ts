"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireOrganizationRoleForPage } from "@/server/tenancy/guards";
import { updateOrganizationName } from "@/server/tenancy/organizations";

export type RenameOrganizationFormState = { error: string } | null;

export async function renameOrganizationAction(
  orgSlug: string,
  _prevState: RenameOrganizationFormState,
  formData: FormData,
): Promise<RenameOrganizationFormState> {
  // OWNER-only: requireOrganizationRoleForPage 404s a MEMBER who reaches
  // this action directly (e.g. by resubmitting a captured form post).
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  const name = String(formData.get("name") ?? "");

  try {
    await updateOrganizationName(context.organization.id, name);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? "Invalid organization name." };
    }
    throw error;
  }

  revalidatePath(`/app/${orgSlug}`);
  return null;
}
