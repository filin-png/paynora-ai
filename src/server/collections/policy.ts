import type { CollectionPolicy } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { CollectionsAutomationNotEntitledError, isCollectionsAutomationEntitled } from "@/server/billing/entitlements";
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
 * newly created policy never sends anything until an OWNER explicitly
 * flips it on via setCollectionPolicyEnabled, which is itself inert unless
 * the organization's own automationEnabled kill switch is also on — see
 * setOrganizationAutomationEnabled below.
 *
 * This is the general "add another policy" primitive, used once an
 * organization already has at least one policy. It deliberately never
 * makes a policy the default or enables it — see createDefaultCollectionPolicy
 * below for the distinct first-time-onboarding path that does.
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

export type EnsuredDefaultPolicy = { policy: CollectionPolicy; created: boolean };

/**
 * The first-time-onboarding path behind the Automation page's "Create
 * default policy" action (only rendered while an organization has zero
 * policies — src/app/app/[orgSlug]/automation/page.tsx). Unlike
 * createCollectionPolicy above, this creates the policy already
 * `isDefault: true, enabled: true` — an organization's very first policy
 * is immediately usable by the automation engine
 * (processOrganizationTick's `isDefault: true, enabled: true` lookup in
 * src/server/collections/engine.ts) on the next tick, with no separate
 * "Make default"/"Enable" steps required. This does not change what an
 * OWNER can still do afterward (disable it, create additional
 * non-default/non-enabled policies via createCollectionPolicy, switch the
 * default elsewhere) — it only fixes the one-time activation gap where a
 * first-time OWNER's only available action left the organization with a
 * policy the engine could never select.
 *
 * Concurrency: two racing first-policy-creation requests for the same
 * organization (e.g. a double-submit) must not both succeed — that would
 * either violate "at most one default policy" or silently create two
 * enabled policies with no default. Serialized the same way
 * lockInvoiceForUpdate (src/server/ar/invoices.ts) serializes concurrent
 * invoice mutations: `SELECT ... FOR UPDATE` on the Organization row for
 * the transaction's duration (an Organization row always exists once the
 * caller has resolved organizationId, unlike CollectionPolicy rows, which
 * don't yet exist on the very race this guards against). The loser of the
 * race, after the lock releases, finds the winner's policy already
 * present and returns it unchanged (`created: false`) instead of creating
 * a duplicate or fighting over which is default.
 */
export async function createDefaultCollectionPolicy(
  organizationId: string,
  rawInput: CollectionPolicyInput,
): Promise<EnsuredDefaultPolicy> {
  const input = collectionPolicyInputSchema.parse(rawInput);
  const orderedSteps = deriveOrderedSteps(input.steps as CollectionPolicyStepInput[]);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;

    const existing = await tx.collectionPolicy.findFirst({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
    });
    if (existing) {
      return { policy: existing, created: false };
    }

    const policy = await tx.collectionPolicy.create({
      data: {
        organizationId,
        name: input.name,
        automationMode: input.automationMode,
        isDefault: true,
        enabled: true,
        currentVersion: 1,
      },
    });
    await tx.collectionPolicyStep.createMany({
      data: orderedSteps.map((step) => ({ policyId: policy.id, version: 1, ...step })),
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "COLLECTION_POLICY_CREATED",
      summary: `Collection policy "${policy.name}" created with ${orderedSteps.length} step(s) and activated as the organization's default policy`,
    });
    return { policy, created: true };
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
  // Activation only (section 6 E) — disabling is always allowed regardless
  // of plan, since it can only reduce what an organization does, never
  // extend it beyond its entitlement.
  if (enabled && !(await isCollectionsAutomationEntitled(organizationId))) {
    throw new CollectionsAutomationNotEntitledError();
  }

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
