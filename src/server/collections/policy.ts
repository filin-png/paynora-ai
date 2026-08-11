import type { CollectionPolicy } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";
import { CollectionsResourceNotFoundError } from "./errors";
import {
  collectionPolicyInputSchema,
  collectionPolicyStepsInputSchema,
  deriveOrderedSteps,
  type CollectionPolicyInput,
  type CollectionPolicyStepInput,
} from "./policy-schema";

/**
 * OWNER-only enforcement for every function in this module happens at the
 * caller (Server Action / route handler) via
 * requireOrganizationRoleForPage(orgSlug, "OWNER") — the same layering
 * already used throughout the app (see src/server/ar/invoices.ts,
 * src/server/operator/approval.ts): domain functions trust an
 * already-authorized organizationId, they don't re-check membership/role
 * themselves. See docs/collections-automation.md#authorization.
 */

export async function listCollectionPolicies(organizationId: string): Promise<CollectionPolicy[]> {
  return prisma.collectionPolicy.findMany({
    where: { organizationId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}

export async function getCollectionPolicy(organizationId: string, policyId: string): Promise<CollectionPolicy> {
  const policy = await prisma.collectionPolicy.findFirst({ where: { id: policyId, organizationId } });
  if (!policy) throw new CollectionsResourceNotFoundError("Collection policy");
  return policy;
}

export async function getCollectionPolicySteps(policyId: string, version: number) {
  return prisma.collectionPolicyStep.findMany({
    where: { policyId, version },
    orderBy: { stepOrder: "asc" },
  });
}

/**
 * Creates a policy at version 1 with its first set of steps, in one
 * transaction. `enabled` always starts `false` regardless of input — a
 * newly created policy (including one seeded from DEFAULT_POLICY_TEMPLATE)
 * never sends anything until an OWNER explicitly flips it on via
 * setCollectionPolicyEnabled, which is itself inert unless the
 * organization's own automationEnabled kill switch is also on — see
 * setOrganizationAutomationEnabled below.
 */
export async function createCollectionPolicy(
  organizationId: string,
  rawInput: CollectionPolicyInput,
): Promise<CollectionPolicy> {
  const input = collectionPolicyInputSchema.parse(rawInput);
  const orderedSteps = deriveOrderedSteps(input.steps as CollectionPolicyStepInput[]);

  return prisma.$transaction(async (tx) => {
    const policy = await tx.collectionPolicy.create({
      data: {
        organizationId,
        name: input.name,
        automationMode: input.automationMode,
        enabled: false,
        currentVersion: 1,
      },
    });
    await tx.collectionPolicyStep.createMany({
      data: orderedSteps.map((step) => ({ policyId: policy.id, version: 1, ...step })),
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "COLLECTION_POLICY_CREATED",
      summary: `Collection policy "${policy.name}" created with ${orderedSteps.length} step(s)`,
    });
    return policy;
  });
}

/**
 * Replaces a policy's step list by writing a new version rather than
 * mutating the existing one — see prisma/schema.prisma's
 * CollectionPolicy/CollectionPolicyStep doc comments and
 * docs/collections-automation.md#policy-versioning. Any CollectionSequence
 * already running under an earlier `policyVersion` keeps reading its own
 * locked version's steps (they're never deleted — see
 * CollectionStepExecution.stepId's onDelete: Restrict), so this can never
 * retroactively change an in-flight sequence's behavior. The policy row
 * itself is locked for the transaction's duration so two concurrent edits
 * can't both read the same `currentVersion` and create two "version 2"
 * step sets.
 */
export async function updateCollectionPolicySteps(
  organizationId: string,
  policyId: string,
  rawSteps: CollectionPolicyStepInput[],
): Promise<CollectionPolicy> {
  const steps = collectionPolicyStepsInputSchema.parse(rawSteps);
  const orderedSteps = deriveOrderedSteps(steps);

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; currentVersion: number }[]>`
      SELECT id, "currentVersion" FROM collection_policies
      WHERE id = ${policyId} AND "organizationId" = ${organizationId}
      FOR UPDATE
    `;
    const locked = rows[0];
    if (!locked) throw new CollectionsResourceNotFoundError("Collection policy");

    const newVersion = locked.currentVersion + 1;
    await tx.collectionPolicyStep.createMany({
      data: orderedSteps.map((step) => ({ policyId, version: newVersion, ...step })),
    });
    const policy = await tx.collectionPolicy.update({
      where: { id: policyId },
      data: { currentVersion: newVersion },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "COLLECTION_POLICY_UPDATED",
      summary: `Collection policy "${policy.name}" steps updated to version ${newVersion}`,
    });
    return policy;
  });
}

export async function renameCollectionPolicy(
  organizationId: string,
  policyId: string,
  name: string,
): Promise<CollectionPolicy> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Policy name is required");

  const policy = await getCollectionPolicy(organizationId, policyId);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.collectionPolicy.update({
      where: { id: policy.id },
      data: { name: trimmed },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "COLLECTION_POLICY_UPDATED",
      summary: `Collection policy renamed to "${trimmed}"`,
    });
    return updated;
  });
}

export async function setCollectionPolicyEnabled(
  organizationId: string,
  policyId: string,
  enabled: boolean,
): Promise<CollectionPolicy> {
  const policy = await getCollectionPolicy(organizationId, policyId);
  if (policy.enabled === enabled) return policy;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.collectionPolicy.update({
      where: { id: policy.id },
      data: { enabled },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "COLLECTION_POLICY_UPDATED",
      summary: `Collection policy "${policy.name}" ${enabled ? "enabled" : "disabled"}`,
    });
    return updated;
  });
}

/**
 * At most one default policy per organization — enforced here at the
 * application layer (not a DB partial unique index) since it's a UX
 * convenience for automatic enrollment (see
 * src/server/collections/enrollment.ts), not a tenant-isolation or
 * financial-safety invariant. Unsets any previous default in the same
 * transaction so there's never a moment with two.
 */
export async function setDefaultCollectionPolicy(
  organizationId: string,
  policyId: string,
): Promise<CollectionPolicy> {
  await getCollectionPolicy(organizationId, policyId);
  return prisma.$transaction(async (tx) => {
    await tx.collectionPolicy.updateMany({
      where: { organizationId, isDefault: true },
      data: { isDefault: false },
    });
    return tx.collectionPolicy.update({
      where: { id: policyId },
      data: { isDefault: true },
    });
  });
}

/**
 * Switching to AUTO_SEND records who authorized it and when — used as the
 * acting userId for the engine's automatic approveActionProposal/
 * sendCommunication calls (src/server/collections/engine.ts), so there is
 * always a real, auditable answer to "who authorized this send", never a
 * null/system sentinel. Switching back to APPROVAL_REQUIRED clears both
 * fields; re-enabling AUTO_SEND later requires a fresh explicit OWNER
 * action, it does not silently reuse a stale authorization.
 */
export async function setCollectionPolicyAutomationMode(
  organizationId: string,
  policyId: string,
  userId: string,
  mode: "APPROVAL_REQUIRED" | "AUTO_SEND",
): Promise<CollectionPolicy> {
  const policy = await getCollectionPolicy(organizationId, policyId);
  if (policy.automationMode === mode) return policy;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.collectionPolicy.update({
      where: { id: policy.id },
      data:
        mode === "AUTO_SEND"
          ? { automationMode: mode, autoSendEnabledByUserId: userId, autoSendEnabledAt: new Date() }
          : { automationMode: mode, autoSendEnabledByUserId: null, autoSendEnabledAt: null },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "COLLECTION_POLICY_UPDATED",
      summary: `Collection policy "${policy.name}" automation mode set to ${mode}`,
    });
    return updated;
  });
}

/**
 * The organization-level half of the two-switch kill switch (see
 * prisma/schema.prisma's Organization.automationEnabled doc comment and
 * docs/collections-automation.md#kill-switch). Disabling this does not
 * pause or stop any individual CollectionSequence — it makes
 * runAutomationTick skip this organization entirely on the next tick,
 * which is both simpler and safer than trying to synchronously touch every
 * sequence: re-enabling later resumes exactly where sequences left off
 * (each sequence's own state is untouched), with no burst of stale
 * reminders, because eligibility is always re-checked fresh on the next
 * tick that actually runs.
 */
export async function setOrganizationAutomationEnabled(
  organizationId: string,
  enabled: boolean,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (org.automationEnabled === enabled) return;
    await tx.organization.update({ where: { id: organizationId }, data: { automationEnabled: enabled } });
    await recordActivityEvent(tx, {
      organizationId,
      type: enabled ? "AUTOMATION_ENABLED" : "AUTOMATION_DISABLED",
      summary: `Collections automation ${enabled ? "enabled" : "disabled"} for the organization`,
    });
  });
}
