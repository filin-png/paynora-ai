"use server";

import { revalidatePath } from "next/cache";

import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { submitSupportRequest } from "@/server/support/service";

export type SubmitSupportRequestFormState = { error: string } | { success: true } | null;

/**
 * Any member — not OWNER-only. A support request is a personal action
 * (any member should be able to ask for help), not an organization-wide
 * bulk operation, so this uses requireOrganizationMembershipForPage
 * rather than requireOrganizationRoleForPage — see
 * src/server/support/service.ts.
 */
export async function submitSupportRequestAction(
  orgSlug: string,
  _prevState: SubmitSupportRequestFormState,
  formData: FormData,
): Promise<SubmitSupportRequestFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const message = String(formData.get("message") ?? "");

  try {
    await submitSupportRequest(context.organization.id, context.user.id, { message });
  } catch (error) {
    if (error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/app/${orgSlug}/settings`);
  return { success: true };
}
