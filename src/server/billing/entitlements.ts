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

export type OrganizationEntitlementsResult = {
  plan: PlanId;
  status: SubscriptionStatus;
  entitlements: PlanEntitlements;
};

/**
 * How each subscription status maps to effective access —
 * docs/billing-entitlements.md#status-effects. `CANCELED` reverts to FREE:
 * data is never deleted, but new quota-consuming actions are bounded by
 * FREE's limits from that point on, exactly like any other downgrade (see
 * assertWithinResourceLimit). `ACTIVE`/`TRIALING`/`PAST_DUE` all grant the
 * subscribed plan's entitlements — `PAST_DUE` is treated as a grace period
 * rather than an immediate downgrade, since this phase has no real payment
 * provider or dunning process to decide when a grace period should end
 * (section 16: no webhooks, no checkout). A future billing adapter is
 * expected to move a subscription to `CANCELED` itself once it determines
 * the grace period is over, not this function.
 */
function deriveEffectivePlan(subscription: { plan: PlanId; status: SubscriptionStatus }): PlanId {
  if (subscription.status === "CANCELED") return "FREE";
  return subscription.plan;
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
): Promise<OrganizationEntitlementsResult> {
  const subscription = await client.organizationSubscription.findUnique({ where: { organizationId } });
  if (!subscription) {
    return { plan: "FREE", status: "ACTIVE", entitlements: PLAN_ENTITLEMENTS.FREE };
  }
  const plan = deriveEffectivePlan(subscription);
  return { plan, status: subscription.status, entitlements: PLAN_ENTITLEMENTS[plan] };
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
