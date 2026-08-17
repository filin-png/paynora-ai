import type { PlanId } from "@prisma/client";

/**
 * The one place PAYNORA's commercial plan catalog is defined — see
 * docs/billing-entitlements.md. Product defaults for the current phase,
 * not final pricing (Phase 11.3 brief, section 4/16: "no RUB/USD prices
 * are required yet, do not make arbitrary pricing decisions"). Changing a
 * number here changes what every organization on that plan is entitled to
 * the next time `getOrganizationEntitlements` is called — there is no
 * separate admin CMS or per-org override table in this phase.
 */
export type { PlanId };

/**
 * A limit that is either a concrete ceiling or explicitly, deliberately
 * unlimited — never a magic number (e.g. `Infinity` or `999999999`)
 * standing in for "unlimited". Every call site that reads a limit must
 * branch on `kind` before comparing against `max`, which is exactly what
 * makes "this plan has no ceiling here" a real, typed fact instead of an
 * implicit convention some caller might get wrong.
 */
export type EntitlementLimit = { readonly kind: "limited"; readonly max: number } | { readonly kind: "unlimited" };

function limited(max: number): EntitlementLimit {
  return { kind: "limited", max };
}

const UNLIMITED: EntitlementLimit = { kind: "unlimited" };

export type PlanEntitlements = {
  /** Non-archived customers — archiving is the organization's own lever to free up quota (see src/server/ar/customers.ts#archiveCustomer). */
  maxCustomers: EntitlementLimit;
  /** Invoices with status OPEN — cancelling is the equivalent lever for invoices. */
  maxOpenInvoices: EntitlementLimit;
  /** OrganizationMember rows. A pending invitation also counts against this — see src/server/tenancy/invitations.ts. */
  maxMembers: EntitlementLimit;
  /** Attempted AI generations (insight/reminder drafting) per rolling 30-day window — see src/server/billing/entitlements.ts#checkAiGenerationQuota. Distinct from, and enforced alongside, the existing per-hour abuse-protection rate limits (src/server/rate-limit/policies.ts) — this is a commercial quota, not an abuse guard. */
  maxAiGenerationsPerMonth: EntitlementLimit;
  /** Whether Collections Automation can be activated/run at all on this plan — see src/server/collections/policy.ts and engine.ts. */
  collectionsAutomationEnabled: boolean;
};

/**
 * Chosen deliberately, not exhaustively engineered: FREE is usable for a
 * genuinely small book of business without feeling like a crippled demo;
 * STARTER and PRO scale up customers/invoices/AI usage together, since
 * they grow together for a real business; PRO's customer/invoice ceiling
 * is intentionally unlimited (record-keeping storage isn't a real cost or
 * abuse vector the way AI spend or team seats are — see the module doc
 * comment on why `unlimited` is a real typed value, not a magic number),
 * while PRO's member seats and AI quota stay finite because those two
 * dimensions map directly to real infrastructure/vendor cost regardless of
 * plan.
 */
export const PLAN_ENTITLEMENTS: Record<PlanId, PlanEntitlements> = {
  FREE: {
    maxCustomers: limited(25),
    maxOpenInvoices: limited(50),
    maxMembers: limited(1),
    maxAiGenerationsPerMonth: limited(20),
    collectionsAutomationEnabled: false,
  },
  STARTER: {
    maxCustomers: limited(250),
    maxOpenInvoices: limited(1000),
    maxMembers: limited(5),
    maxAiGenerationsPerMonth: limited(200),
    collectionsAutomationEnabled: true,
  },
  PRO: {
    maxCustomers: UNLIMITED,
    maxOpenInvoices: UNLIMITED,
    maxMembers: limited(25),
    maxAiGenerationsPerMonth: limited(2000),
    collectionsAutomationEnabled: true,
  },
};

export function getPlanEntitlements(plan: PlanId): PlanEntitlements {
  return PLAN_ENTITLEMENTS[plan];
}

/**
 * Narrows a limit to its numeric ceiling, for callers that already know
 * (or require) it isn't unlimited — mainly test fixtures that need a
 * concrete number to loop up to. Throws rather than silently returning
 * `Infinity` for an unlimited entitlement, since a caller reaching for a
 * number here has almost certainly mis-assumed the plan it's looking at.
 */
export function limitMax(limit: EntitlementLimit): number {
  if (limit.kind !== "limited") throw new Error("Expected a limited entitlement, got unlimited");
  return limit.max;
}
