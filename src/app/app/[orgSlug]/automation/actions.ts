"use server";

import { revalidatePath } from "next/cache";

import { runAutomationTick } from "@/server/collections/engine";
import {
  createDefaultCollectionPolicy,
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
 * (DEFAULT_POLICY_TEMPLATE) as the organization's first policy, already
 * active — isDefault: true, enabled: true — via
 * createDefaultCollectionPolicy, so eligible open invoices enroll on the
 * very next automation tick with no separate "Make default"/"Enable"
 * steps required. Only ever reachable while the organization has zero
 * policies (see the button's render condition in page.tsx); a concurrent
 * double-submit resolves safely to the same single first policy rather
 * than creating a duplicate.
 */
export async function createDefaultPolicyAction(orgSlug: string): Promise<void> {
  const context = await requireOrganizationRoleForPage(orgSlug, "OWNER");
  await createDefaultCollectionPolicy(context.organization.id, {
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
