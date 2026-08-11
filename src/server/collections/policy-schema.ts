import { z } from "zod";
import type { CollectionStepAction, ReminderTone } from "@prisma/client";

/**
 * The server-side allowlist for Phase 5 policy step actions — same pattern
 * as ALLOWED_ACTION_TYPES in src/server/operator/proposals.ts. Adding a
 * value to the CollectionStepAction enum does not, by itself, make it
 * choosable from a policy; it must be added here deliberately.
 */
export const ALLOWED_COLLECTION_STEP_ACTIONS: readonly CollectionStepAction[] = [
  "SEND_PAYMENT_REMINDER",
  "NOTIFY_OWNER",
];

const MAX_STEPS_PER_POLICY = 20;
const MAX_DAYS_AFTER_DUE = 3650;

export const collectionPolicyStepInputSchema = z.object({
  daysAfterDue: z.number().int().min(0).max(MAX_DAYS_AFTER_DUE),
  action: z.enum(ALLOWED_COLLECTION_STEP_ACTIONS as [CollectionStepAction, ...CollectionStepAction[]]),
  tone: z.enum(["SOFT", "STANDARD", "FIRM"] satisfies [ReminderTone, ...ReminderTone[]]).default("STANDARD"),
});

export type CollectionPolicyStepInput = z.input<typeof collectionPolicyStepInputSchema>;

/**
 * `stepOrder` is never client-supplied: a step's position is entirely
 * determined by its `daysAfterDue`, sorted ascending. This removes a whole
 * class of "invalid ordering" input (a client claiming step 1 fires after
 * step 2) by construction, while still rejecting the one thing that's
 * actually ambiguous — two steps claiming the same day threshold.
 */
export const collectionPolicyStepsInputSchema = z
  .array(collectionPolicyStepInputSchema)
  .min(1, "A policy needs at least one step")
  .max(MAX_STEPS_PER_POLICY, `A policy can have at most ${MAX_STEPS_PER_POLICY} steps`)
  .refine(
    (steps) => new Set(steps.map((step) => step.daysAfterDue)).size === steps.length,
    { message: "Two steps cannot share the same daysAfterDue threshold" },
  );

export const collectionPolicyInputSchema = z.object({
  name: z.string().trim().min(1, "Policy name is required").max(200),
  automationMode: z.enum(["APPROVAL_REQUIRED", "AUTO_SEND"]).default("APPROVAL_REQUIRED"),
  steps: collectionPolicyStepsInputSchema,
});

export type CollectionPolicyInput = z.input<typeof collectionPolicyInputSchema>;

/**
 * Sorts steps by daysAfterDue and assigns the resulting 1-based stepOrder —
 * the single place that derives order from the validated input, called by
 * both policy creation and policy step updates so the two can never
 * disagree about how order is computed.
 */
export function deriveOrderedSteps(
  steps: CollectionPolicyStepInput[],
): Array<{ stepOrder: number; daysAfterDue: number; action: CollectionStepAction; tone: ReminderTone }> {
  return [...steps]
    .sort((a, b) => a.daysAfterDue - b.daysAfterDue)
    .map((step, index) => ({
      stepOrder: index + 1,
      daysAfterDue: step.daysAfterDue,
      action: step.action,
      tone: step.tone ?? "STANDARD",
    }));
}

/**
 * A safe, documented onboarding template (docs/collections-automation.md
 * #default-policy) — day+1 soft, day+3 standard, day+7 firm, day+14 firm
 * with an owner-notify escalation. Only ever used to *pre-fill* an OWNER's
 * explicit "create policy" action; nothing imports this to auto-create a
 * policy, and even a created-from-this-template policy is `enabled: false`
 * and requires the organization's own automationEnabled kill switch too —
 * see src/server/collections/policy.ts.
 */
export const DEFAULT_POLICY_TEMPLATE: { name: string; steps: CollectionPolicyStepInput[] } = {
  name: "Default AR Policy",
  steps: [
    { daysAfterDue: 1, action: "SEND_PAYMENT_REMINDER", tone: "SOFT" },
    { daysAfterDue: 3, action: "SEND_PAYMENT_REMINDER", tone: "STANDARD" },
    { daysAfterDue: 7, action: "SEND_PAYMENT_REMINDER", tone: "FIRM" },
    { daysAfterDue: 14, action: "NOTIFY_OWNER", tone: "FIRM" },
  ],
};
