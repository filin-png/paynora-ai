import { Prisma, type PlanId, type SubscriptionStatus } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { checkRateLimit } from "@/server/rate-limit/service";
import { PLAN_ENTITLEMENTS, type EntitlementLimit, type PlanEntitlements } from "./plans";

/**
 * The one authoritative server-side entitlement layer (Phase 11.3 brief,
 * section 4) — see docs/billing-entitlements.md. AR/AI/Collections domain
 * code asks this module "is X allowed", never inspects `plan === "PRO"`
 * itself; that keeps the plan catalog and its numbers centralized in
 * plans.ts and swappable without touching call sites.
 *
 * Concurrency (section 8): every quota-consuming write (customer/invoice/
 * member creation) locks the Organization row (`SELECT ... FOR UPDATE`)
 * for the duration of its transaction before counting current usage —
 * exactly the same row-locking idiom already established for Invoice in
 * src/server/ar/invoices.ts#lockInvoiceForUpdate, applied here to
 * Organization since every entitlement is organization-scoped. Documented
 * MVP limitation: this one lock serializes ALL quota-consuming writes for
 * one organization (a customer create blocks a concurrent invoice create
 * in the same org, not just a concurrent customer create) rather than a
 * separate lock per resource kind — correct, simple, and cheap at this
 * product's scale; a genuinely high-concurrency multi-tenant write path
 * would want a finer-grained scheme, which is explicitly out of scope
 * here (section 8: "do not introduce distributed locks or a job queue").
 */

type PrismaClientLike = typeof prisma | Prisma.TransactionClient;

export type ResourceKind = "customers" | "invoices" | "members";

const RESOURCE_LABEL: Record<ResourceKind, string> = {
  customers: "customers",
  invoices: "open invoices",
  members: "organization members",
};

export class EntitlementLimitExceededError extends Error {
  constructor(
    public readonly resource: ResourceKind,
    public readonly limit: number,
    public readonly usage: number,
  ) {
    super(
      `This organization's current plan allows up to ${limit} ${RESOURCE_LABEL[resource]} (currently at ${usage}). Upgrade the plan to add more.`,
    );
    this.name = "EntitlementLimitExceededError";
  }
}

export class CollectionsAutomationNotEntitledError extends Error {
  constructor() {
    super("Collections Automation is not available on this organization's current plan.");
    this.name = "CollectionsAutomationNotEntitledError";
  }
}

/**
 * The boolean-feature counterpart to `EntitlementLimitExceededError`
 * (which is for count-based resources). Thrown by any `assert*Entitled`
 * check in this module — see `assertCopilotEntitled`/`assertWalletEntitled`
 * below — so a caller (a Server Action's generic `{error: string}` state)
 * can recognize "this failure was a plan gate" via `isFeatureNotEntitledMessage`
 * the same dependency-free way `upgrade-hint.tsx#isEntitlementLimitMessage`
 * already does for the count-based error.
 */
export class FeatureNotEntitledError extends Error {
  constructor(public readonly feature: string) {
    super(`${feature} is not available on this organization's current plan. Upgrade the plan to enable it.`);
    this.name = "FeatureNotEntitledError";
  }
}

export function isFeatureNotEntitledMessage(message: string): boolean {
  return message.endsWith("Upgrade the plan to enable it.");
}

export type OrganizationEntitlementsResult = {
  /** The plan actually billed/stored — never itself changed by trial expiry, only status is (see effectiveStatus). */
  plan: PlanId;
  /** The raw stored status — may be TRIALING even after trialEndsAt has passed; see effectiveStatus for the derived-on-read truth. */
  status: SubscriptionStatus;
  /** The status this function actually reasoned from — TRIALING becomes EXPIRED here once trialEndsAt has passed, without writing anything. */
  effectiveStatus: SubscriptionStatus;
  entitlements: PlanEntitlements;
};

/**
 * How each subscription status maps to effective access —
 * docs/commercial-product-architecture.md#status-effects. `CANCELED` and
 * `EXPIRED` both revert to FREE: data is never deleted, but new
 * quota-consuming actions are bounded by FREE's limits from that point on,
 * exactly like any other downgrade (see assertWithinResourceLimit).
 * `ACTIVE`/`TRIALING`/`PAST_DUE` all grant the subscribed plan's
 * entitlements — `PAST_DUE` is treated as a grace period rather than an
 * immediate downgrade, since this phase has no real payment provider or
 * dunning process to decide when a grace period should end. A future
 * billing adapter is expected to move a subscription to `CANCELED` itself
 * once it determines the grace period is over, not this function.
 */
function deriveEffectivePlan(effectiveStatus: SubscriptionStatus, plan: PlanId): PlanId {
  if (effectiveStatus === "CANCELED" || effectiveStatus === "EXPIRED") return "FREE";
  return plan;
}

/**
 * A stored `TRIALING` status whose `trialEndsAt` has passed is treated as
 * `EXPIRED` here — a pure, read-time derivation, never a write. No
 * scheduler exists to flip the stored status the moment a trial ends (see
 * the module doc comment's "no distributed locks or a job queue"
 * constraint), so this is deliberately computed fresh on every read,
 * exactly like `isAutoSendStillAuthorized` re-checks automation
 * entitlement on every tick rather than trusting a cached decision.
 */
function deriveEffectiveStatus(
  subscription: { status: SubscriptionStatus; trialEndsAt: Date | null },
  now: Date,
): SubscriptionStatus {
  if (subscription.status === "TRIALING" && subscription.trialEndsAt && subscription.trialEndsAt <= now) {
    return "EXPIRED";
  }
  return subscription.status;
}

/**
 * The one function that answers "what is this organization entitled to
 * right now". Never throws: an organization somehow missing its
 * subscription row (should be unreachable — see createOrganization and
 * this phase's migration backfill) degrades to the same FREE access a
 * brand-new organization gets, rather than turning every AR/AI/automation
 * read that calls this into a 500.
 */
export async function getOrganizationEntitlements(
  organizationId: string,
  client: PrismaClientLike = prisma,
  now: Date = new Date(),
): Promise<OrganizationEntitlementsResult> {
  const subscription = await client.organizationSubscription.findUnique({ where: { organizationId } });
  if (!subscription) {
    return {
      plan: "FREE",
      status: "ACTIVE",
      effectiveStatus: "ACTIVE",
      entitlements: PLAN_ENTITLEMENTS.FREE,
    };
  }
  const effectiveStatus = deriveEffectiveStatus(subscription, now);
  const plan = deriveEffectivePlan(effectiveStatus, subscription.plan);
  return { plan, status: subscription.status, effectiveStatus, entitlements: PLAN_ENTITLEMENTS[plan] };
}

/**
 * Throws `FeatureNotEntitledError` unless the organization's current plan
 * has Copilot enabled — the one enforcement point
 * src/server/copilot/service.ts#answerCopilotQuestion calls before doing
 * anything else, so a disallowed call never even reaches the deterministic
 * answer builders, let alone AI.
 */
export async function assertCopilotEntitled(organizationId: string): Promise<void> {
  const { entitlements } = await getOrganizationEntitlements(organizationId);
  if (!entitlements.copilotEnabled) throw new FeatureNotEntitledError("Copilot");
}

/**
 * Throws `FeatureNotEntitledError` unless the organization's current plan
 * has Wallet enabled — checked inside
 * src/server/wallet/wallets.ts#connectWallet, alongside (not instead of)
 * the deployment-level `WALLET_PROVIDER` gate.
 */
export async function assertWalletEntitled(organizationId: string): Promise<void> {
  const { entitlements } = await getOrganizationEntitlements(organizationId);
  if (!entitlements.walletEnabled) throw new FeatureNotEntitledError("Wallet");
}

export type OrganizationUsageSummary = {
  customers: number;
  openInvoices: number;
  members: number;
};

/** Current usage across every counted resource — the "18 / 100" half of the plan/usage UI. */
export async function getOrganizationUsage(organizationId: string): Promise<OrganizationUsageSummary> {
  const [customers, openInvoices, members] = await Promise.all([
    prisma.customer.count({ where: { organizationId, archivedAt: null } }),
    prisma.invoice.count({ where: { organizationId, status: "OPEN" } }),
    prisma.organizationMember.count({ where: { organizationId } }),
  ]);
  return { customers, openInvoices, members };
}

async function lockOrganizationForUpdate(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
}

async function countResourceUsage(
  client: PrismaClientLike,
  organizationId: string,
  resource: ResourceKind,
): Promise<number> {
  switch (resource) {
    case "customers":
      // Archived customers don't count — archiving is this organization's
      // own lever to free up quota. See src/server/ar/customers.ts#archiveCustomer.
      return client.customer.count({ where: { organizationId, archivedAt: null } });
    case "invoices":
      // Only OPEN invoices count — cancelling is the equivalent lever.
      return client.invoice.count({ where: { organizationId, status: "OPEN" } });
    case "members":
      return client.organizationMember.count({ where: { organizationId } });
  }
}

function limitFor(entitlements: PlanEntitlements, resource: ResourceKind): EntitlementLimit {
  switch (resource) {
    case "customers":
      return entitlements.maxCustomers;
    case "invoices":
      return entitlements.maxOpenInvoices;
    case "members":
      return entitlements.maxMembers;
  }
}

/**
 * The single enforcement primitive for customer/invoice/member creation
 * (section 6 A/B/C, section 9's downgrade behavior). Must be called inside
 * the same transaction as the row it's guarding, before that row is
 * created — never after, and never outside a transaction, or the
 * lock-then-count-then-create sequence isn't atomic (see the module doc
 * comment on concurrency). Throws `EntitlementLimitExceededError` and
 * creates nothing when the organization is already at its limit;
 * otherwise returns normally and the caller proceeds to create its row
 * while still holding the lock.
 *
 * This is also exactly what makes downgrade behavior (section 9) correct
 * with zero special-case code: a downgraded organization whose usage now
 * exceeds its new plan's limit fails this check on its very next
 * create attempt, identically to an organization that simply grew past its
 * limit organically — existing data is never touched, only new creation is
 * blocked, and the block lifts itself the moment usage drops back under
 * the limit (e.g. an archive, a cancellation, or an upgrade).
 */
export async function assertWithinResourceLimit(
  tx: Prisma.TransactionClient,
  organizationId: string,
  resource: ResourceKind,
): Promise<void> {
  await lockOrganizationForUpdate(tx, organizationId);
  const { entitlements } = await getOrganizationEntitlements(organizationId, tx);
  const limit = limitFor(entitlements, resource);
  if (limit.kind === "unlimited") return;

  const usage = await countResourceUsage(tx, organizationId, resource);
  if (usage >= limit.max) {
    throw new EntitlementLimitExceededError(resource, limit.max, usage);
  }
}

/**
 * The member-seat check for *creating* an invitation (section 6 C) — a
 * distinct rule from `assertWithinResourceLimit(..., "members")`, which
 * guards the moment a membership row is actually created (invitation
 * acceptance, the authoritative enforcement point). This one additionally
 * counts still-PENDING invitations, so an OWNER can't create more pending
 * invites than there are seats to ever accept them into — a
 * defense-in-depth / better-UX check, not the last line of defense (the
 * accept-time `assertWithinResourceLimit` call in
 * src/server/tenancy/invitations.ts#acceptInvitation is what actually
 * guarantees the seat count can never be exceeded, including under
 * concurrent accepts).
 */
export async function assertCanCreateInvitation(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  await lockOrganizationForUpdate(tx, organizationId);
  const { entitlements } = await getOrganizationEntitlements(organizationId, tx);
  const limit = entitlements.maxMembers;
  if (limit.kind === "unlimited") return;

  const [members, pendingInvitations] = await Promise.all([
    tx.organizationMember.count({ where: { organizationId } }),
    tx.organizationInvitation.count({ where: { organizationId, status: "PENDING" } }),
  ]);
  const usage = members + pendingInvitations;
  if (usage >= limit.max) {
    throw new EntitlementLimitExceededError("members", limit.max, usage);
  }
}

const AI_GENERATION_QUOTA_SCOPE = "billing:ai-generation:quota";
/**
 * A fixed 30-day rolling window, not a calendar month — the same simple,
 * documented approximation src/server/rate-limit/service.ts's fixed-window
 * model already makes for its hourly policies, applied at a longer scale.
 * Good enough for a commercial usage ceiling; not a billing-invoice-grade
 * calendar boundary.
 */
const AI_GENERATION_QUOTA_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether this organization's plan still has AI-generation quota left this
 * period — checked (and, if allowed, consumed) BEFORE any AI provider is
 * ever invoked, so a denied quota never makes an external call (section 6
 * D). Deliberately reuses the existing rate-limit counter infrastructure
 * (`checkRateLimit`) with its own distinct scope rather than a new table —
 * see docs/billing-entitlements.md#ai-quota-vs-rate-limit for why this is
 * still conceptually distinct from, and enforced alongside (never instead
 * of), the existing per-hour abuse-protection policies
 * (src/server/rate-limit/policies.ts's `aiGenerationPolicy`/
 * `operatorRunPolicy`): those bound how fast one call site can spend AI
 * budget regardless of plan; this bounds how much a plan is entitled to
 * spend at all. Both checks run at every real AI call site — see
 * src/server/operator/insights.ts and src/server/communications/draft.ts.
 *
 * Never throws: an unexpected rate-limiter error degrades to "quota
 * unavailable" (denies the AI attempt, falls back to the deterministic
 * path), the same fail-safe-toward-the-provider-call posture
 * `aiGenerationAllowed` in draft.ts already takes for the abuse-protection
 * check.
 */
export async function checkAiGenerationQuota(organizationId: string, now: Date = new Date()): Promise<boolean> {
  const { entitlements } = await getOrganizationEntitlements(organizationId);
  const limit = entitlements.maxAiGenerationsPerMonth;
  if (limit.kind === "unlimited") return true;

  try {
    const result = await checkRateLimit(
      AI_GENERATION_QUOTA_SCOPE,
      organizationId,
      { maxAttempts: limit.max, windowMs: AI_GENERATION_QUOTA_WINDOW_MS },
      now,
    );
    return result.allowed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[billing] AI generation quota check failed — degrading to deny (deterministic fallback still applies): ${message}`);
    return false;
  }
}

/**
 * Read-only view of the current AI-generation quota window, for the
 * plan/usage UI (section 11) — never consumes a slot, unlike
 * `checkAiGenerationQuota`. Recomputes the same fixed-window boundary
 * `checkRateLimit` uses internally (src/server/rate-limit/service.ts's
 * `currentWindowStart`, not exported) rather than importing it, so this
 * stays a plain read against `RateLimitCounter` with no risk of ever
 * mutating it — deliberately not reusing `checkRateLimit` itself, which
 * always increments on read.
 */
export async function getAiGenerationUsage(
  organizationId: string,
  now: Date = new Date(),
): Promise<{ used: number; limit: EntitlementLimit }> {
  const { entitlements } = await getOrganizationEntitlements(organizationId);
  const limit = entitlements.maxAiGenerationsPerMonth;
  if (limit.kind === "unlimited") return { used: 0, limit };

  const windowStart = new Date(Math.floor(now.getTime() / AI_GENERATION_QUOTA_WINDOW_MS) * AI_GENERATION_QUOTA_WINDOW_MS);
  const counter = await prisma.rateLimitCounter.findUnique({
    where: { scope_key_windowStart: { scope: AI_GENERATION_QUOTA_SCOPE, key: organizationId, windowStart } },
  });
  return { used: counter?.count ?? 0, limit };
}

/**
 * Whether Collections Automation can be activated/run at all on this
 * organization's current plan (section 6 E). Read fresh at every call site
 * that matters — activation (`setOrganizationAutomationEnabled`) and every
 * actual tick execution (`processOrganizationTick`,
 * `isAutoSendStillAuthorized`) — rather than cached anywhere, so a
 * downgrade takes effect on an already-`automationEnabled` organization's
 * very next tick without any special migration or cleanup step. See
 * src/server/collections/policy.ts and engine.ts.
 */
export async function isCollectionsAutomationEntitled(organizationId: string): Promise<boolean> {
  const { entitlements } = await getOrganizationEntitlements(organizationId);
  return entitlements.collectionsAutomationEnabled;
}

export type BillingPeriod = {
  start: Date;
  end: Date;
  /** "provider" once a real BillingProvider populates currentPeriodStart/End (see prisma/schema.prisma); "derived" until then. */
  source: "provider" | "derived";
};

/**
 * Rolling monthly windows anchored to `anchor` (calendar-month arithmetic,
 * not a fixed 30-day duration like the AI quota window — a billing period
 * conventionally tracks calendar months). Bounded loop: at most one
 * iteration per elapsed month since `anchor`, no external I/O inside it.
 */
function deriveRollingMonthlyPeriod(anchor: Date, now: Date): BillingPeriod {
  let periodStart = new Date(anchor);
  for (;;) {
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    if (periodEnd > now) {
      return { start: periodStart, end: periodEnd, source: "derived" };
    }
    periodStart = periodEnd;
  }
}

/**
 * The current "billing period" for an organization — real data either way:
 * a real BillingProvider's `currentPeriodStart`/`currentPeriodEnd` once one
 * exists (see prisma/schema.prisma's OrganizationSubscription doc comment),
 * or a calendar-month window derived from the subscription's own
 * `createdAt` until then. Never a fabricated/arbitrary date — see
 * docs/commercial-product-architecture.md#billing-period.
 */
export async function getBillingPeriod(organizationId: string, now: Date = new Date()): Promise<BillingPeriod> {
  const subscription = await prisma.organizationSubscription.findUnique({ where: { organizationId } });
  if (!subscription) return deriveRollingMonthlyPeriod(now, now);
  if (subscription.currentPeriodStart && subscription.currentPeriodEnd) {
    return { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd, source: "provider" };
  }
  return deriveRollingMonthlyPeriod(subscription.createdAt, now);
}

const COPILOT_USAGE_SCOPE = "billing:copilot:usage";

/**
 * Metering only — never denies, and is never itself the entitlement check
 * (that is `assertCopilotEntitled`, plus the existing AI-generation quota
 * inside copilot/service.ts#elaborate). Reuses the same RateLimitCounter
 * infrastructure and 30-day rolling window as AI-generation usage, with a
 * `maxAttempts` high enough it can never actually deny — `checkRateLimit`
 * always increments its counter regardless of the `allowed` result, so
 * this is purely "how many times was Copilot asked a question", visible on
 * the Billing UI. Called once per `answerCopilotQuestion` invocation,
 * regardless of whether AI elaboration itself succeeds. Best-effort: a
 * metering failure must never break a Copilot answer.
 */
export async function recordCopilotUsage(organizationId: string, now: Date = new Date()): Promise<void> {
  try {
    await checkRateLimit(
      COPILOT_USAGE_SCOPE,
      organizationId,
      { maxAttempts: Number.MAX_SAFE_INTEGER, windowMs: AI_GENERATION_QUOTA_WINDOW_MS },
      now,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[billing] Copilot usage metering failed (non-fatal, does not affect the answer): ${message}`);
  }
}

/** Read-only view of the current Copilot usage count — same non-mutating read pattern as getAiGenerationUsage. */
export async function getCopilotUsage(organizationId: string, now: Date = new Date()): Promise<number> {
  const windowStart = new Date(Math.floor(now.getTime() / AI_GENERATION_QUOTA_WINDOW_MS) * AI_GENERATION_QUOTA_WINDOW_MS);
  const counter = await prisma.rateLimitCounter.findUnique({
    where: { scope_key_windowStart: { scope: COPILOT_USAGE_SCOPE, key: organizationId, windowStart } },
  });
  return counter?.count ?? 0;
}

export type OrganizationUsageOverview = {
  plan: PlanId;
  status: SubscriptionStatus;
  effectiveStatus: SubscriptionStatus;
  entitlements: PlanEntitlements;
  billingPeriod: BillingPeriod;
  resourceUsage: OrganizationUsageSummary;
  aiGenerationUsage: { used: number; limit: EntitlementLimit };
  copilotUsageCount: number;
};

/**
 * The one aggregation point for everything the Billing UI (Settings ->
 * Billing) and the Overview value dashboard need — assembled entirely from
 * the functions above, never a second computation of any of these numbers.
 * See docs/commercial-product-architecture.md#usage-metering.
 */
export async function getOrganizationUsageOverview(organizationId: string): Promise<OrganizationUsageOverview> {
  const [entitlementsResult, billingPeriod, resourceUsage, aiGenerationUsage, copilotUsageCount] = await Promise.all([
    getOrganizationEntitlements(organizationId),
    getBillingPeriod(organizationId),
    getOrganizationUsage(organizationId),
    getAiGenerationUsage(organizationId),
    getCopilotUsage(organizationId),
  ]);
  return { ...entitlementsResult, billingPeriod, resourceUsage, aiGenerationUsage, copilotUsageCount };
}
