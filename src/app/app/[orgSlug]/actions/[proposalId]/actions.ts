"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prepareReminderCommunication } from "@/server/communications/draft";
import { updateCommunicationDraft } from "@/server/communications/editing";
import { reconcileStaleSendingCommunication, sendCommunication } from "@/server/communications/send";
import { requireOrganizationMembershipForPage, requireOrganizationRoleForPage } from "@/server/tenancy/guards";
import { deliveryResolutionInput, resolveDelivery } from "@/server/communications/delivery-resolutions";
import { getLocale } from "@/lib/i18n/get-locale";
import { getDictionary } from "@/lib/i18n";

export type CommunicationFormState = { error: string } | null;

function revalidateProposalPage(orgSlug: string, proposalId: string): void {
  revalidatePath(`/app/${orgSlug}/actions/${proposalId}`);
  revalidatePath(`/app/${orgSlug}/actions`);
}

export async function prepareCommunicationAction(orgSlug: string, proposalId: string): Promise<void> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  await prepareReminderCommunication(context.organization.id, proposalId);
  revalidateProposalPage(orgSlug, proposalId);
}

export async function updateCommunicationAction(
  orgSlug: string,
  proposalId: string,
  communicationId: string,
  _prevState: CommunicationFormState,
  formData: FormData,
): Promise<CommunicationFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  try {
    await updateCommunicationDraft(context.organization.id, communicationId, {
      subject: String(formData.get("subject") ?? ""),
      body: String(formData.get("body") ?? ""),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? "Invalid input." };
    }
    if (error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }
  revalidateProposalPage(orgSlug, proposalId);
  return null;
}

export async function sendCommunicationAction(
  orgSlug: string,
  proposalId: string,
  communicationId: string,
  _prevState: CommunicationFormState,
): Promise<CommunicationFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  try {
    await sendCommunication(context.organization.id, communicationId, context.user.id);
  } catch (error) {
    if (error instanceof Error) return { error: error.message };
    throw error;
  }
  revalidateProposalPage(orgSlug, proposalId);
  return null;
}

export async function resolveDeliveryAction(
  orgSlug: string,
  proposalId: string,
  communicationId: string,
  attemptId: string,
  previousId: string | null,
  _previous: CommunicationFormState,
  formData: FormData,
): Promise<CommunicationFormState> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  try {
    const input = deliveryResolutionInput.parse({
      attemptId, previousId, decision: formData.get("decision"), reason: formData.get("reason"),
      evidenceEventId: formData.get("evidenceEventId") || undefined,
      incidentId: formData.get("incidentId") || undefined,
    });
    await resolveDelivery(
      { organizationId: context.organization.id, userId: context.user.id },
      { communicationId, proposalId },
      input,
    );
  } catch {
    return { error: getDictionary(await getLocale()).actionDetail.resolutionRejected };
  }
  revalidateProposalPage(orgSlug, proposalId);
  return null;
}

export async function reconcileStaleSendingCommunicationAction(
  orgSlug: string,
  proposalId: string,
  communicationId: string,
  _prevState: CommunicationFormState,
): Promise<CommunicationFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  try {
    await reconcileStaleSendingCommunication(context.organization.id, communicationId);
  } catch (error) {
    if (error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }
  revalidateProposalPage(orgSlug, proposalId);
  return null;
}
