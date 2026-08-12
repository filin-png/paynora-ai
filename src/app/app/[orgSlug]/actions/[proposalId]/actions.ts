"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prepareReminderCommunication } from "@/server/communications/draft";
import { updateCommunicationDraft } from "@/server/communications/editing";
import { reconcileStaleSendingCommunication, sendCommunication } from "@/server/communications/send";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";

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

async function trySend(
  orgSlug: string,
  proposalId: string,
  communicationId: string,
  options: { acknowledgeUncertainRisk?: boolean },
): Promise<CommunicationFormState> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  try {
    await sendCommunication(context.organization.id, communicationId, context.user.id, options);
  } catch (error) {
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
  return trySend(orgSlug, proposalId, communicationId, {});
}

export async function resendUncertainCommunicationAction(
  orgSlug: string,
  proposalId: string,
  communicationId: string,
  _prevState: CommunicationFormState,
): Promise<CommunicationFormState> {
  return trySend(orgSlug, proposalId, communicationId, { acknowledgeUncertainRisk: true });
}

/**
 * Phase 9 (docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-3): the explicit
 * recovery step for a communication genuinely stuck at SENDING. Never
 * sends anything itself — it only moves the communication to UNCERTAIN
 * (admitting the outcome is unknown), after which the existing, already-
 * tested "Resend anyway" flow (`resendUncertainCommunicationAction`
 * above) is what actually requires acknowledging duplicate-send risk
 * before attempting anything further.
 */
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
