"use server";

import { revalidatePath } from "next/cache";

import { approveActionProposal, dismissActionProposal } from "@/server/operator/approval";
import { runOperator } from "@/server/operator/pipeline";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";

export async function runOperatorAction(orgSlug: string): Promise<void> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  await runOperator(context.organization.id);
  revalidatePath(`/app/${orgSlug}/actions`);
}

export async function approveProposalAction(orgSlug: string, proposalId: string): Promise<void> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  await approveActionProposal(context.organization.id, proposalId, context.user.id);
  revalidatePath(`/app/${orgSlug}/actions`);
}

export async function dismissProposalAction(orgSlug: string, proposalId: string): Promise<void> {
  const context = await requireOrganizationMembershipForPage(orgSlug);
  await dismissActionProposal(context.organization.id, proposalId, context.user.id);
  revalidatePath(`/app/${orgSlug}/actions`);
}
