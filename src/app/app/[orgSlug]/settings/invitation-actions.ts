"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { EntitlementLimitExceededError } from "@/server/billing/entitlements";
import { requireOrganizationRoleForPage } from "@/server/tenancy/guards";
import {
  AlreadyOrganizationMemberError,
  createInvitation,
  DuplicatePendingInvitationError,
  InvitationNotRevocableError,
  revokeInvitation,
} from "@/server/tenancy/invitations";
import { RateLimitExceededError } from "@/server/rate-limit/errors";

export type InviteMemberFormState = { error: string } | { success: true } | null;

/** OWNER-only: requireOrganizationRoleForPage 404s a MEMBER who reaches this action directly. */
export async function inviteMemberAction(
  orgSlug: string,
  _prevState: InviteMemberFormState,
  formData: FormData,
): Promise<InviteMemberFormState> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  const email = String(formData.get("email") ?? "");
  const role = formData.get("role") === "OWNER" ? "OWNER" : "MEMBER";

  try {
    await createInvitation(context.organization.id, context.user.id, email, role);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? "Invalid email address." };
    }
    if (
      error instanceof AlreadyOrganizationMemberError ||
      error instanceof DuplicatePendingInvitationError ||
      error instanceof RateLimitExceededError ||
      error instanceof EntitlementLimitExceededError
    ) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/app/${orgSlug}/settings`);
  return { success: true };
}

export type RevokeInvitationFormState = { error: string } | null;

/** OWNER-only, scoped to this organization — see revokeInvitation's own doc comment for the cross-tenant guarantee. */
export async function revokeInvitationAction(
  orgSlug: string,
  invitationId: string,
  _prevState: RevokeInvitationFormState,
  _formData: FormData,
): Promise<RevokeInvitationFormState> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");

  try {
    await revokeInvitation(context.organization.id, invitationId);
  } catch (error) {
    if (error instanceof InvitationNotRevocableError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/app/${orgSlug}/settings`);
  return null;
}
