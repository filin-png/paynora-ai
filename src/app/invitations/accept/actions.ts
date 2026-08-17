"use server";

import { redirect } from "next/navigation";

import { EntitlementLimitExceededError } from "@/server/billing/entitlements";
import { requireUserForPage } from "@/server/tenancy/guards";
import { acceptInvitation, InvalidOrExpiredInvitationError } from "@/server/tenancy/invitations";

export type AcceptInvitationFormState = { error: string } | null;

export async function acceptInvitationAction(
  token: string,
  _prevState: AcceptInvitationFormState,
  _formData: FormData,
): Promise<AcceptInvitationFormState> {
  const user = await requireUserForPage();

  let organizationSlug: string;
  try {
    const result = await acceptInvitation(user, token);
    organizationSlug = result.organizationSlug;
  } catch (error) {
    if (error instanceof InvalidOrExpiredInvitationError || error instanceof EntitlementLimitExceededError) {
      return { error: error.message };
    }
    throw error;
  }

  redirect(`/app/${organizationSlug}`);
}
