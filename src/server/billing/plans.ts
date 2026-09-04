import type { PlanId } from "@prisma/client";

import { majorToMinor } from "@/server/ar/money";
import type { Currency } from "@/server/ar/currency";

/**
 * The one place PAYNORA's commercial plan catalog is defined — see
 * docs/commercial-product-architecture.md. Phase 11.3 deliberately shipped
 * with no price field ("no RUB/USD prices are required yet, do not make
 * arbitrary pricing decisions"); Phase 19 adds real prices, explicitly
 * provided by the founder (not invented here) — see `priceMinor` below.
 * Changing a number here changes what every organization on that plan is
 * entitled to (and is charged, once a real BillingProvider exists) the
 * next time `getOrganizationEntitlements` is called — there is no separate
 * admin CMS or per-org override table in this phase.
 */
export type { PlanId };

/**
 * Explicit top-to-bottom order — the one place plan ordering is defined.
 * Every UI/comparison that needs "is plan X higher than plan Y" (e.g. to
 * distinguish a safe self-serve downgrade from an upgrade that needs real
 * payment) reads this, rather than re-deriving order from `priceMinor` at
 * every call site or hardcoding a second array.
 */
export const PLAN_ORDER: readonly PlanId[] = ["FREE", "STARTER", "BUSINESS", "PRO"];

export function planRank(plan: PlanId): number {
  return PLAN_ORDER.indexOf(plan);
}

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
  /**
   * Phase 19: whether the Phase 16 Proactive Copilot
   * (src/server/copilot/service.ts#answerCopilotQuestion) can be called at
   * all on this plan — enforced server-side inside that function, not just
   * hidden in a future UI. Distinct from `maxAiGenerationsPerMonth`: that
   * bounds how many AI-assisted generations a plan gets across every
   * AI call site; this is a hard on/off for one specific feature.
   */
  copilotEnabled: boolean;
  /**
   * Phase 19: whether this organization can connect a Wallet at all —
   * enforced server-side inside src/server/wallet/wallets.ts#connectWallet.
   * Wallet itself is still gated at the deployment level by
   * `WALLET_PROVIDER` (env; see docs/wallet-architecture.md) — this is the
   * additional per-organization commercial gate on top of that.
   */
  walletEnabled: boolean;
  /**
   * Phase 19: reserved for the Phase 11 customer-facing integrations
   * (AccountingProvider/CRMProvider/BankingProvider —
   * docs/provider-strategy.md) — none of which exist yet
   * ("documented only, per validated customer demand"). This flag is real
   * and typed so the plan catalog already models the dimension, but it
   * currently gates nothing: there is no integration to gate. Wire an
   * `assert*Entitled` check here the same way copilot/wallet were, the
   * day the first real integration adapter is built — do not treat its
   * present lack of an enforcement point as a bug.
   */
  integrationsEnabled: boolean;
  /**
   * Phase 19: PAYNORA's own subscription price for this plan, in bigint
   * minor units — the same money representation as every other amount in
   * this codebase (src/server/ar/money.ts). Real, founder-provided prices,
   * not invented here. FREE is priced at 0. This is what a future
   * BillingProvider checkout would charge; nothing in this phase actually
   * charges it (see src/server/billing/service.ts — no real adapter yet).
   */
  priceMinor: bigint;
  /** Currency `priceMinor` is denominated in. RUB for every plan — see docs/provider-strategy.md's "works from Russia" priority. */
  currency: Currency;
};

/**
 * Chosen deliberately, not exhaustively engineered: FREE is usable for a
 * genuinely small book of business without feeling like a crippled demo;
 * STARTER/BUSINESS/PRO scale up customers/invoices/AI usage together,
 * since they grow together for a real business; PRO's customer/invoice
 * ceiling is intentionally unlimited (record-keeping storage isn't a real
 * cost or abuse vector the way AI spend or team seats are — see the module
 * doc comment on why `unlimited` is a real typed value, not a magic
 * number), while PRO's member seats and AI quota stay finite because those
 * two dimensions map directly to real infrastructure/vendor cost
 * regardless of plan. Copilot is a STARTER+ feature (a genuinely new gate,
 * safe to add: the feature has no callers yet, so this is not a
 * regression); Wallet is a BUSINESS+ feature (crypto payment tracking is
 * priced as a premium capability, on top of Wallet's own deployment-level
 * `WALLET_PROVIDER` gate).
 */
export const PLAN_ENTITLEMENTS: Record<PlanId, PlanEntitlements> = {
  FREE: {
    maxCustomers: limited(25),
    maxOpenInvoices: limited(50),
    maxMembers: limited(1),
    maxAiGenerationsPerMonth: limited(20),
    collectionsAutomationEnabled: false,
    copilotEnabled: false,
    walletEnabled: false,
    integrationsEnabled: false,
    priceMinor: 0n,
    currency: "RUB",
  },
  STARTER: {
    maxCustomers: limited(250),
    maxOpenInvoices: limited(1000),
    maxMembers: limited(5),
    maxAiGenerationsPerMonth: limited(200),
    collectionsAutomationEnabled: true,
    copilotEnabled: true,
    walletEnabled: false,
    integrationsEnabled: false,
    priceMinor: majorToMinor(1990),
    currency: "RUB",
  },
  BUSINESS: {
    maxCustomers: limited(1000),
    maxOpenInvoices: limited(4000),
    maxMembers: limited(12),
    maxAiGenerationsPerMonth: limited(800),
    collectionsAutomationEnabled: true,
    copilotEnabled: true,
    walletEnabled: true,
    integrationsEnabled: true,
    priceMinor: majorToMinor(4990),
    currency: "RUB",
  },
  PRO: {
    maxCustomers: UNLIMITED,
    maxOpenInvoices: UNLIMITED,
    maxMembers: limited(25),
    maxAiGenerationsPerMonth: limited(2000),
    collectionsAutomationEnabled: true,
    copilotEnabled: true,
    walletEnabled: true,
    integrationsEnabled: true,
    priceMinor: majorToMinor(9990),
    currency: "RUB",
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
