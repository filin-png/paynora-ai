"use server";

import { revalidatePath } from "next/cache";

import { clearDemoData, seedDemoData } from "@/server/onboarding/demo-data";
import { requireOrganizationRoleForPage } from "@/server/tenancy/guards";

/** OWNER-only: requireOrganizationRoleForPage 404s a MEMBER who reaches this action directly. */
export async function seedDemoDataAction(orgSlug: string): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await seedDemoData(context.organization.id);
  revalidatePath(`/app/${orgSlug}`);
  revalidatePath(`/app/${orgSlug}/settings`);
}

/** OWNER-only, scoped to this organization — see clearDemoData's own doc comment. */
export async function clearDemoDataAction(orgSlug: string): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await clearDemoData(context.organization.id);
  revalidatePath(`/app/${orgSlug}`);
  revalidatePath(`/app/${orgSlug}/settings`);
}
