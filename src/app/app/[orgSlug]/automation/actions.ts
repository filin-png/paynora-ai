"use server";

import { revalidatePath } from "next/cache";

import { runAutomationTick } from "@/server/collections/engine";
import {
  createCollectionPolicy,
  setCollectionPolicyAutomationMode,
  setCollectionPolicyEnabled,
  setDefaultCollectionPolicy,
  setOrganizationAutomationEnabled,
} from "@/server/collections/policy";
import { DEFAULT_POLICY_TEMPLATE } from "@/server/collections/policy-schema";
import {
  pauseCollectionSequence,
  resumeCollectionSequence,
  stopCollectionSequenceManually,
} from "@/server/collections/sequences";
import { requireOrganizationRoleForPage } from "@/server/tenancy/guards";

function revalidateAutomation(orgSlug: string): void {
  revalidatePath(`/app/${orgSlug}/automation`);
}

/** OWNER-only: the organization-level kill switch (docs/collections-automation.md#kill-switch). */
export async function setAutomationEnabledAction(orgSlug: string, enabled: boolean): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await setOrganizationAutomationEnabled(context.organization.id, enabled);
  revalidateAutomation(orgSlug);
}

/**
 * OWNER-only. Seeds the documented safe onboarding template
 * (DEFAULT_POLICY_TEMPLATE) — still disabled and not the default until an
 * OWNER explicitly flips those on separately, same two-step-minimum as
 * every other automation config change.
 */
export async function createDefaultPolicyAction(orgSlug: string): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await createCollectionPolicy(context.organization.id, {
    name: DEFAULT_POLICY_TEMPLATE.name,
    steps: DEFAULT_POLICY_TEMPLATE.steps,
  });
  revalidateAutomation(orgSlug);
}

export async function setPolicyEnabledAction(orgSlug: string, policyId: string, enabled: boolean): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await setCollectionPolicyEnabled(context.organization.id, policyId, enabled);
  revalidateAutomation(orgSlug);
}

export async function setDefaultPolicyAction(orgSlug: string, policyId: string): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await setDefaultCollectionPolicy(context.organization.id, policyId);
  revalidateAutomation(orgSlug);
}

/** OWNER-only. Switching to AUTO_SEND records this OWNER as the acting authorizer — see CollectionPolicy.autoSendEnabledByUserId. */
export async function setPolicyAutomationModeAction(
  orgSlug: string,
  policyId: string,
  mode: "APPROVAL_REQUIRED" | "AUTO_SEND",
): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await setCollectionPolicyAutomationMode(context.organization.id, policyId, context.user.id, mode);
  revalidateAutomation(orgSlug);
}

export async function pauseSequenceAction(orgSlug: string, sequenceId: string): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await pauseCollectionSequence(context.organization.id, sequenceId);
  revalidateAutomation(orgSlug);
}

export async function resumeSequenceAction(orgSlug: string, sequenceId: string): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await resumeCollectionSequence(context.organization.id, sequenceId);
  revalidateAutomation(orgSlug);
}

export async function stopSequenceAction(orgSlug: string, sequenceId: string): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await stopCollectionSequenceManually(context.organization.id, sequenceId);
  revalidateAutomation(orgSlug);
}

/**
 * Development-only manual trigger — see docs/collections-automation.md
 * #no-fake-scheduler. Only wired up behind a NODE_ENV !== "production"
 * check in the page itself; this action additionally re-verifies OWNER
 * membership so it can never be reached by a MEMBER even if the page
 * check were somehow bypassed.
 */
export async function runManualAutomationTickAction(orgSlug: string): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Manual automation tick is a development-only capability");
  }
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await runAutomationTick(new Date(), { organizationId: context.organization.id });
  revalidateAutomation(orgSlug);
}
