import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { CollectionsAutomationNotEntitledError } from "@/server/billing/entitlements";
import { setOrganizationPlan } from "@/server/billing/subscription";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { CollectionsResourceNotFoundError } from "./errors";
import {
  createCollectionPolicy,
  createDefaultCollectionPolicy,
  getCollectionPolicySteps,
  renameCollectionPolicy,
  setCollectionPolicyAutomationMode,
  setCollectionPolicyEnabled,
  setDefaultCollectionPolicy,
  setOrganizationAutomationEnabled,
  updateCollectionPolicySteps,
} from "./policy";
import { DEFAULT_POLICY_TEMPLATE } from "./policy-schema";

beforeEach(async () => {
  await resetDatabase();
});

describe("createCollectionPolicy", () => {
  it("creates a policy at version 1, disabled by default, with steps ordered by daysAfterDue", async () => {
    const { organization } = await createTestOrganization();

    const policy = await createCollectionPolicy(organization.id, {
      name: "My Policy",
      steps: [
        { daysAfterDue: 7, action: "SEND_PAYMENT_REMINDER", tone: "FIRM" },
        { daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER", tone: "SOFT" },
      ],
    });

    expect(policy.enabled).toBe(false);
    expect(policy.currentVersion).toBe(1);
    expect(policy.automationMode).toBe("APPROVAL_REQUIRED");

    const steps = await getCollectionPolicySteps(policy.id, 1);
    expect(steps.map((s) => s.daysAfterDue)).toEqual([1, 7]);
    expect(steps.map((s) => s.stepOrder)).toEqual([1, 2]);
  });

  it("accepts the documented default policy template unchanged", async () => {
    const { organization } = await createTestOrganization();
    const policy = await createCollectionPolicy(organization.id, {
      name: DEFAULT_POLICY_TEMPLATE.name,
      steps: DEFAULT_POLICY_TEMPLATE.steps,
    });
    const steps = await getCollectionPolicySteps(policy.id, 1);
    expect(steps.map((s) => s.daysAfterDue)).toEqual([1, 3, 7, 14]);
    // Never sends without an explicit organization-level opt-in, even
    // though the template itself is a "safe onboarding default".
    expect(policy.enabled).toBe(false);
  });

  it("rejects duplicate daysAfterDue thresholds", async () => {
    const { organization } = await createTestOrganization();
    await expect(
      createCollectionPolicy(organization.id, {
        name: "Bad Policy",
        steps: [
          { daysAfterDue: 3, action: "SEND_PAYMENT_REMINDER" },
          { daysAfterDue: 3, action: "SEND_PAYMENT_REMINDER" },
        ],
      }),
    ).rejects.toThrow(z.ZodError);
  });

  it("rejects an empty step list", async () => {
    const { organization } = await createTestOrganization();
    await expect(createCollectionPolicy(organization.id, { name: "Empty", steps: [] })).rejects.toThrow(z.ZodError);
  });

  it("rejects an unallowlisted action", async () => {
    const { organization } = await createTestOrganization();
    await expect(
      createCollectionPolicy(organization.id, {
        name: "Bad Action",
        // @ts-expect-error deliberately invalid for the test
        steps: [{ daysAfterDue: 1, action: "CALL_CUSTOMER" }],
      }),
    ).rejects.toThrow(z.ZodError);
  });
});

describe("createDefaultCollectionPolicy", () => {
  it("creates the organization's first policy already default and enabled", async () => {
    const { organization } = await createTestOrganization();

    const { policy, created } = await createDefaultCollectionPolicy(organization.id, {
      name: DEFAULT_POLICY_TEMPLATE.name,
      steps: DEFAULT_POLICY_TEMPLATE.steps,
    });

    expect(created).toBe(true);
    expect(policy.isDefault).toBe(true);
    expect(policy.enabled).toBe(true);
    expect(policy.currentVersion).toBe(1);

    const steps = await getCollectionPolicySteps(policy.id, 1);
    expect(steps.map((s) => s.daysAfterDue)).toEqual([1, 3, 7, 14]);
  });

  it("does not affect an organization's default/enabled state for its second policy", async () => {
    const { organization } = await createTestOrganization();
    const { policy: first } = await createDefaultCollectionPolicy(organization.id, {
      name: "First",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });

    const second = await createCollectionPolicy(organization.id, {
      name: "Second",
      steps: [{ daysAfterDue: 2, action: "SEND_PAYMENT_REMINDER" }],
    });

    expect(second.isDefault).toBe(false);
    expect(second.enabled).toBe(false);

    const refreshedFirst = await prisma.collectionPolicy.findUniqueOrThrow({ where: { id: first.id } });
    expect(refreshedFirst.isDefault).toBe(true);
    expect(refreshedFirst.enabled).toBe(true);
  });

  it("is idempotent: calling it again for an organization that already has a policy returns the existing one unchanged", async () => {
    const { organization } = await createTestOrganization();
    const { policy: firstCall } = await createDefaultCollectionPolicy(organization.id, {
      name: DEFAULT_POLICY_TEMPLATE.name,
      steps: DEFAULT_POLICY_TEMPLATE.steps,
    });

    const { policy: secondCall, created } = await createDefaultCollectionPolicy(organization.id, {
      name: "A different name — should be ignored",
      steps: [{ daysAfterDue: 99, action: "NOTIFY_OWNER" }],
    });

    expect(created).toBe(false);
    expect(secondCall.id).toBe(firstCall.id);
    expect(secondCall.name).toBe(DEFAULT_POLICY_TEMPLATE.name);

    const allPolicies = await prisma.collectionPolicy.findMany({ where: { organizationId: organization.id } });
    expect(allPolicies).toHaveLength(1);
  });

  it("never creates two default/enabled policies when two first-time requests race", async () => {
    const { organization } = await createTestOrganization();

    const [resultA, resultB] = await Promise.all([
      createDefaultCollectionPolicy(organization.id, {
        name: "Race A",
        steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
      }),
      createDefaultCollectionPolicy(organization.id, {
        name: "Race B",
        steps: [{ daysAfterDue: 2, action: "SEND_PAYMENT_REMINDER" }],
      }),
    ]);

    // Exactly one of the two racing calls actually created the policy;
    // the other observed it already existing.
    expect([resultA.created, resultB.created].filter(Boolean)).toHaveLength(1);
    expect(resultA.policy.id).toBe(resultB.policy.id);

    const allPolicies = await prisma.collectionPolicy.findMany({ where: { organizationId: organization.id } });
    expect(allPolicies).toHaveLength(1);
    expect(allPolicies[0]!.isDefault).toBe(true);
    expect(allPolicies[0]!.enabled).toBe(true);

    const defaultPolicies = allPolicies.filter((p) => p.isDefault);
    expect(defaultPolicies).toHaveLength(1);
  });

  it("scopes to the organization: two different organizations each get their own first default policy", async () => {
    const { organization: orgA } = await createTestOrganization("OrgA");
    const { organization: orgB } = await createTestOrganization("OrgB");

    const { policy: policyA } = await createDefaultCollectionPolicy(orgA.id, {
      name: "A",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });
    const { policy: policyB } = await createDefaultCollectionPolicy(orgB.id, {
      name: "B",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });

    expect(policyA.organizationId).toBe(orgA.id);
    expect(policyB.organizationId).toBe(orgB.id);
    expect(policyA.isDefault).toBe(true);
    expect(policyB.isDefault).toBe(true);
  });
});

describe("updateCollectionPolicySteps", () => {
  it("writes a new version and bumps currentVersion without touching the old version's steps", async () => {
    const { organization } = await createTestOrganization();
    const policy = await createCollectionPolicy(organization.id, {
      name: "P",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });

    const updated = await updateCollectionPolicySteps(organization.id, policy.id, [
      { daysAfterDue: 2, action: "SEND_PAYMENT_REMINDER" },
      { daysAfterDue: 5, action: "NOTIFY_OWNER" },
    ]);

    expect(updated.currentVersion).toBe(2);
    const v1Steps = await getCollectionPolicySteps(policy.id, 1);
    const v2Steps = await getCollectionPolicySteps(policy.id, 2);
    expect(v1Steps).toHaveLength(1);
    expect(v1Steps[0]!.daysAfterDue).toBe(1);
    expect(v2Steps.map((s) => s.daysAfterDue)).toEqual([2, 5]);
  });

  it("rejects updates for a policy belonging to another organization", async () => {
    const { organization: orgA } = await createTestOrganization("OrgA");
    const { organization: orgB } = await createTestOrganization("OrgB");
    const policy = await createCollectionPolicy(orgA.id, {
      name: "P",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });

    await expect(
      updateCollectionPolicySteps(orgB.id, policy.id, [{ daysAfterDue: 2, action: "SEND_PAYMENT_REMINDER" }]),
    ).rejects.toThrow(CollectionsResourceNotFoundError);
  });
});

describe("setCollectionPolicyEnabled / setDefaultCollectionPolicy", () => {
  it("enables and disables a policy", async () => {
    const { organization } = await createTestOrganization();
    const policy = await createCollectionPolicy(organization.id, {
      name: "P",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });
    expect(policy.enabled).toBe(false);

    const enabled = await setCollectionPolicyEnabled(organization.id, policy.id, true);
    expect(enabled.enabled).toBe(true);

    const disabled = await setCollectionPolicyEnabled(organization.id, policy.id, false);
    expect(disabled.enabled).toBe(false);
  });

  it("keeps at most one default policy per organization", async () => {
    const { organization } = await createTestOrganization();
    const policyA = await createCollectionPolicy(organization.id, {
      name: "A",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });
    const policyB = await createCollectionPolicy(organization.id, {
      name: "B",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });

    await setDefaultCollectionPolicy(organization.id, policyA.id);
    await setDefaultCollectionPolicy(organization.id, policyB.id);

    const refreshedA = await prisma.collectionPolicy.findUniqueOrThrow({ where: { id: policyA.id } });
    const refreshedB = await prisma.collectionPolicy.findUniqueOrThrow({ where: { id: policyB.id } });
    expect(refreshedA.isDefault).toBe(false);
    expect(refreshedB.isDefault).toBe(true);
  });
});

describe("setCollectionPolicyAutomationMode", () => {
  it("records the authorizing user and timestamp when switching to AUTO_SEND, and clears them going back", async () => {
    const { organization, user } = await createTestOrganization();
    const policy = await createCollectionPolicy(organization.id, {
      name: "P",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });

    const autoSend = await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    expect(autoSend.automationMode).toBe("AUTO_SEND");
    expect(autoSend.autoSendEnabledByUserId).toBe(user.id);
    expect(autoSend.autoSendEnabledAt).not.toBeNull();

    const back = await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "APPROVAL_REQUIRED");
    expect(back.automationMode).toBe("APPROVAL_REQUIRED");
    expect(back.autoSendEnabledByUserId).toBeNull();
    expect(back.autoSendEnabledAt).toBeNull();
  });

  it("leaves an audit trail for both the AUTO_SEND switch and the switch back", async () => {
    const { organization, user } = await createTestOrganization();
    const policy = await createCollectionPolicy(organization.id, {
      name: "P",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });

    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "AUTO_SEND");
    await setCollectionPolicyAutomationMode(organization.id, policy.id, user.id, "APPROVAL_REQUIRED");

    const events = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, type: "COLLECTION_POLICY_UPDATED" },
      orderBy: { createdAt: "asc" },
    });
    // One for creation, one for AUTO_SEND, one for the switch back.
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a mode switch for a policy belonging to another organization, and never actually switches it", async () => {
    const { organization } = await createTestOrganization("Owner");
    const other = await createTestOrganization("Attacker");
    const policy = await createCollectionPolicy(organization.id, {
      name: "P",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });

    await expect(
      setCollectionPolicyAutomationMode(other.organization.id, policy.id, other.user.id, "AUTO_SEND"),
    ).rejects.toThrow();

    const stillApprovalRequired = await prisma.collectionPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(stillApprovalRequired.automationMode).toBe("APPROVAL_REQUIRED");
    expect(stillApprovalRequired.autoSendEnabledByUserId).toBeNull();
  });
});

describe("renameCollectionPolicy", () => {
  it("renames and rejects a blank name", async () => {
    const { organization } = await createTestOrganization();
    const policy = await createCollectionPolicy(organization.id, {
      name: "Old Name",
      steps: [{ daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER" }],
    });
    const renamed = await renameCollectionPolicy(organization.id, policy.id, "New Name");
    expect(renamed.name).toBe("New Name");
    await expect(renameCollectionPolicy(organization.id, policy.id, "   ")).rejects.toThrow();
  });
});

describe("setOrganizationAutomationEnabled", () => {
  it("toggles the organization-level kill switch and is idempotent", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "STARTER"); // FREE (the new-org default) does not entitle automation
    let org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(org.automationEnabled).toBe(false);

    await setOrganizationAutomationEnabled(organization.id, true);
    org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(org.automationEnabled).toBe(true);

    // Idempotent no-op — does not throw, does not add a second audit row.
    await setOrganizationAutomationEnabled(organization.id, true);
    const events = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, type: "AUTOMATION_ENABLED" },
    });
    expect(events).toHaveLength(1);
  });

  // --- Phase 11.3 (brief section 6 E): plan entitlement gates activation.
  it("a FREE organization cannot activate Collections Automation", async () => {
    const { organization } = await createTestOrganization();
    await expect(setOrganizationAutomationEnabled(organization.id, true)).rejects.toThrow(
      CollectionsAutomationNotEntitledError,
    );
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(org.automationEnabled).toBe(false);
  });

  it("a STARTER organization can activate Collections Automation", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "STARTER");
    await expect(setOrganizationAutomationEnabled(organization.id, true)).resolves.toBeUndefined();
  });

  it("a PRO organization can activate Collections Automation", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "PRO");
    await expect(setOrganizationAutomationEnabled(organization.id, true)).resolves.toBeUndefined();
  });

  it("disabling is always allowed regardless of plan — the safe direction never needs entitlement", async () => {
    const { organization } = await createTestOrganization();
    await setOrganizationPlan(organization.id, "STARTER");
    await setOrganizationAutomationEnabled(organization.id, true);
    await setOrganizationPlan(organization.id, "FREE");

    await expect(setOrganizationAutomationEnabled(organization.id, false)).resolves.toBeUndefined();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(org.automationEnabled).toBe(false);
  });
});
