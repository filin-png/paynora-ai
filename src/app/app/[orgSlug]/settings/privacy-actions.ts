"use server";

import { revalidatePath } from "next/cache";

import { setOrganizationAnalyticsEnabled } from "@/server/tenancy/organizations";
import { requireOrganizationRoleForPage } from "@/server/tenancy/guards";

/** OWNER-only: requireOrganizationRoleForPage 404s a MEMBER who reaches this action directly. */
export async function setAnalyticsEnabledAction(orgSlug: string, enabled: boolean): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await setOrganizationAnalyticsEnabled(context.organization.id, enabled);
  revalidatePath(`/app/${orgSlug}/settings`);
}
