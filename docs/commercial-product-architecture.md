# Commercial Product Architecture (Phase 19)

What this phase built: a complete commercial product layer — priced plans,
server-enforced feature entitlements, real usage metering, a subscription
lifecycle (trial/active/past-due/canceled/expired), a Billing UI, and an
honest, data-grounded "PAYNORA Financial Impact" panel — on top of the
technical foundation Phases 11.3/13/16/17/18 already built. Provider-neutral
throughout: still no real Stripe/YooKassa adapter, no real payment
collection, no real API keys. See `docs/provider-strategy.md` for why that
boundary exists and stays in place until a separate, explicitly-approved
phase.

This document is the current source of truth for the commercial layer.
`docs/billing-entitlements.md` (Phase 11.3) is kept as historical record of
the original three-plan, unpriced design; `docs/integration-architecture.md`
#billing and `docs/provider-strategy.md`#billingprovider cover the
`BillingProvider` webhook-verification abstraction and Phase 18's
subscription-payment ingestion pipeline, both unchanged by this phase.

## Architectural audit — what already existed, what this phase reused

Before writing any code, this phase read: `prisma/schema.prisma`'s full
billing-adjacent surface, `src/server/billing/{entitlements,plans,
subscription,service,types,errors}.ts`, `src/server/rate-limit/*`,
`src/server/copilot/service.ts`, `docs/proactive-financial-operations.md`
(Phase 16), the Action Center/Operator pipeline, `src/server/wallet/*`,
AR's `Invoice`/`Payment`/`Customer`/`ActivityEvent`, `src/server/tenancy/
{context,guards}.ts`, and the existing Settings UI (`billing-tab.tsx` was
already a real, non-mock plan/usage view).

**Findings:**
- The entitlement layer (`assertWithinResourceLimit`, `getOrganizationEntitlements`,
  the Organization-row-lock concurrency model) was already correct and
  complete for count-based resources (customers/invoices/members) — nothing
  here needed rebuilding, only extending with new boolean feature gates.
- AI-generation quota already reused `RateLimitCounter` as a real,
  Postgres-backed, atomic usage meter (a rolling 30-day window) — this
  phase's Copilot usage metering follows the exact same pattern rather than
  inventing a second counting mechanism.
- `OrganizationSubscription` already had `currentPeriodStart`/`currentPeriodEnd`
  (nullable, reserved for a future real billing adapter) — this phase's
  "billing period" concept reads those when set and derives a calendar-month
  window from `createdAt` otherwise, rather than adding a new schema concept.
- Phase 18's `SubscriptionPayment` ledger already existed as PAYNORA's own
  payment history — this phase added only an organization-scoped read of it
  (`getOrganizationSubscriptionPayments`), never a second payment-history
  table.
- Settings → Billing already existed as a real (non-mock) plan/usage view —
  this phase extended it rather than building a parallel page.
- Copilot (`answerCopilotQuestion`) and Wallet (`connectWallet`) had **zero**
  plan-based gating before this phase — genuinely new, safe-to-add server-side
  checks (Copilot has no UI callers yet at all; Wallet was gated only by the
  deployment-level `WALLET_PROVIDER` env, never per-organization).
- Action Center / proactive intelligence (attention score, Daily Brief, cash-
  flow risk) were deliberately **not** newly gated — see
  [Deliberate non-gates](#deliberate-non-gates) below.

## Plan model

Four fixed plans, one catalog, `src/server/billing/plans.ts`
(`PLAN_ENTITLEMENTS`), ordered by `PLAN_ORDER`/`planRank`:

| | FREE | STARTER | BUSINESS | PRO |
|---|---|---|---|---|
| Price/mo (RUB) | Free | 1,990 ₽ | 4,990 ₽ | 9,990 ₽ |
| Customers | 25 | 250 | 1,000 | Unlimited |
| Open invoices | 50 | 1,000 | 4,000 | Unlimited |
| Members | 1 | 5 | 12 | 25 |
| AI generations / 30d | 20 | 200 | 800 | 2,000 |
| Collections Automation | – | ✓ | ✓ | ✓ |
| Proactive Copilot | – | ✓ | ✓ | ✓ |
| Wallet | – | – | ✓ | ✓ |
| Integrations (reserved) | – | – | ✓ | ✓ |

Prices are real, founder-provided values (`priceMinor`, bigint minor units —
the same `src/server/ar/money.ts` convention as every other amount in this
codebase — plus `currency`, RUB for every plan per `docs/provider-strategy.md`'s
"works from Russia" priority). Nothing here invents a number: this phase's
brief supplied 1,990 / 4,990 / 9,990 ₽ directly.

`PLAN_ORDER`/`planRank(plan)` is the one place plan ordering is defined —
every "is this an upgrade or a downgrade" decision (self-serve plan change,
UI button choice) reads it, never re-derives order from price or hardcodes
a second array. Three UI surfaces previously each hardcoded their own copy of
plan labels/blurbs/order (the landing page, the Settings comparison, the
Billing tab); this phase consolidated them into
`src/components/billing/plan-labels.ts` and `plans.ts`'s own `PLAN_ORDER`.

Integrations is a genuinely reserved flag: `AccountingProvider`/
`CRMProvider`/`BankingProvider` (`docs/provider-strategy.md`) don't exist
yet ("documented only, per validated customer demand"), so
`integrationsEnabled` currently gates nothing — it exists so the catalog
already models the dimension. Wire an `assert*Entitled` check the day the
first real integration adapter is built, the same way Copilot/Wallet were
wired this phase — its present lack of an enforcement point is intentional,
not an oversight.

## Entitlements — PLAN → ENTITLEMENTS → FEATURE ACCESS → USAGE LIMITS

`src/server/billing/entitlements.ts` is still the one authoritative
server-side layer. Every check in this phase is an `assert*Entitled`
function that re-reads the organization's subscription from the database on
every call — nothing is cached, nothing trusts a client-supplied value:

- `assertWithinResourceLimit` / `assertCanCreateInvitation` — unchanged,
  count-based (customers/invoices/members).
- `checkAiGenerationQuota` — unchanged, the rolling-window AI quota.
- `isCollectionsAutomationEntitled` — unchanged.
- `assertCopilotEntitled(organizationId)` — **new**. Throws
  `FeatureNotEntitledError` for a plan without `copilotEnabled`. Called as
  the literal first line of `answerCopilotQuestion`
  (`src/server/copilot/service.ts`), before any deterministic answer
  builder or AI call.
- `assertWalletEntitled(organizationId)` — **new**. Throws
  `FeatureNotEntitledError` for a plan without `walletEnabled`. Called as
  the first line of `connectWallet` (`src/server/wallet/wallets.ts`), before
  the provider call or any database write — a denied attempt never reaches
  the wallet table at all.

`FeatureNotEntitledError` is the boolean-feature counterpart to the
existing count-based `EntitlementLimitExceededError`; `isFeatureNotEntitledMessage`
mirrors `upgrade-hint.tsx`'s existing dependency-free error-message
recognition pattern for Client Component forms.

**Every check is server-side.** No entitlement in this codebase is ever
enforced by hiding a button — see
[Security audit](#security--entitlement-bypass-audit).

## Subscription lifecycle

`SubscriptionStatus`: `ACTIVE`, `TRIALING`, `PAST_DUE`, `CANCELED`, and
(Phase 19) `EXPIRED`.

`getOrganizationEntitlements` now returns both the raw stored `status` and a
derived `effectiveStatus`:

- **CANCELED / EXPIRED** → effective plan reverts to FREE. Data is never
  deleted; only new quota-consuming creation is bounded by FREE's limits.
- **ACTIVE / TRIALING / PAST_DUE** → the subscribed plan's entitlements
  apply. `PAST_DUE` remains a grace period (unchanged from Phase 11.3):
  there is still no real payment provider or dunning process to decide when
  a grace period should end — a future billing adapter is expected to move
  a subscription to `CANCELED` itself.
- **A TRIALING subscription whose `trialEndsAt` has passed** is treated as
  `EXPIRED` — a pure read-time derivation (`deriveEffectiveStatus`), never a
  write. There is no scheduler in this codebase to flip a stored status the
  moment a trial ends (same "no distributed locks or a job queue"
  constraint the codebase already documents elsewhere), so this is computed
  fresh on every `getOrganizationEntitlements` call, the same way
  `isAutoSendStillAuthorized` re-checks automation entitlement on every
  tick rather than trusting a cached decision.

**Self-serve lifecycle actions** (`src/server/billing/subscription.ts`,
wired to Settings → Billing, OWNER-only):

- `cancelOrganizationSubscription` — sets status to `CANCELED`, never
  touches the stored `plan`. Idempotent.
- `reactivateOrganizationSubscription` — restores `ACTIVE` on the exact
  plan that was canceled. Throws `InvalidSubscriptionTransitionError`
  unless the current status is `CANCELED` — cannot be used to reach a plan
  higher than the organization already had, because cancellation never
  touched `plan` in the first place.
- `changeOrganizationPlanSelfServe(organizationId, targetPlan)` — allowed
  only when `planRank(targetPlan) <= planRank(current.plan)` (a downgrade
  or lateral move). Any higher-ranked target throws
  `UpgradeRequiresPaymentError` — self-serve **cannot** upgrade, by
  construction, regardless of what a client requests. See
  [Checkout](#checkout--why-upgrade-is-not-self-serve).

`setOrganizationPlan` (Phase 11.3) is unchanged — it remains the one place
subscription state is actually written, and the shape a real billing
adapter's webhook handler would call too (Phase 18's
`applySubscriptionWebhookEvent` already calls it via this same path for
status transitions).

## Usage metering

`usage event → meter → billing period → current usage → entitlement limit → allow/deny`,
built entirely from infrastructure that already existed:

- **Customers / open invoices / members** — exact, live `COUNT` queries
  against Postgres (`getOrganizationUsage`), not an approximated or cached
  meter. This is deliberately *more* exact than an event-log meter would be.
- **AI generations** — `RateLimitCounter`-backed rolling 30-day window
  (`getAiGenerationUsage`), unchanged from Phase 11.3.
- **Copilot requests** (Phase 19) — `recordCopilotUsage`/`getCopilotUsage`
  reuse the exact same `RateLimitCounter` mechanism and window, with a
  `maxAttempts` high enough it can never itself deny (`checkRateLimit`
  always increments its counter regardless of the `allowed` result). This
  is metering only, visible on the Billing UI — the actual entitlement
  check is `assertCopilotEntitled`, and the actual AI-cost gate is the
  existing AI-generation quota inside `copilot/service.ts#elaborate`.
- **Billing period** (Phase 19) — `getBillingPeriod(organizationId)`
  returns `{ start, end, source }`. `source: "provider"` once a real
  `BillingProvider` populates `currentPeriodStart`/`currentPeriodEnd`;
  `source: "derived"` until then, a calendar-month window computed from the
  subscription's own `createdAt` (bounded-loop calendar arithmetic, no
  external I/O). Real data either way — never a fabricated date.
- **`getOrganizationUsageOverview(organizationId)`** — the one aggregation
  point assembling all of the above for the Billing UI and the value
  dashboard, so neither UI recomputes anything a lower layer already
  computed.

No Prisma model was added for usage metering: `RateLimitCounter` (existing)
and live `COUNT` queries (existing) already cover every dimension asked
for. Adding a new table would have been the exact kind of parallel system
this phase's brief said not to build.

## Billing domain separation

**Subscription payment (PAYNORA's own revenue) is never mixed with
customer invoice payment (an organization's own AR).** This was already
true structurally before this phase (Phase 6/18's own doc comments say so
explicitly); this phase's job was to keep it true while adding UI:

| | Subscription payment | Customer invoice payment |
|---|---|---|
| What it represents | An organization paying PAYNORA for its plan | An organization's own customer paying *them* |
| Model | `SubscriptionPayment` (Phase 18) | `Payment` (Phase 2) |
| Domain | `src/server/billing/*` | `src/server/ar/*` |
| Read for UI | `getOrganizationSubscriptionPayments` (Phase 19, org-scoped) | `src/server/ar/summary.ts`, `listRecentPayments` |
| Shown in | Settings → Billing | Overview, Invoice detail |

`getOrganizationSubscriptionPayments` (new, Phase 19) is deliberately
distinct from `scripts/subscription-report.ts`'s founder-only, all-
organizations CLI (Phase 17/18): this is what one organization's own
members may see about their *own* PAYNORA subscription, scoped by
`organizationId` like every other tenant-scoped read in this codebase —
never a second query path that could leak another organization's billing
history.

## Checkout — why "upgrade" is not self-serve

Settings → Billing shows a real "Change plan" section. Downgrade and
cancellation are real, immediate, self-serve actions (see
[Subscription lifecycle](#subscription-lifecycle)) — they can only reduce
access, so there is no bypass risk in allowing them without payment.
**Upgrade is not**: `changeOrganizationPlanSelfServe` still refuses any
target plan ranked above the current one (`UpgradeRequiresPaymentError`),
regardless of what the UI does or what a client sends directly — this
Phase 19 invariant is unchanged.

As of Phase 20, when `BILLING_PROVIDER=yookassa` is configured, an upgrade
is no longer a placeholder — it goes through a real checkout with a real
payment provider (YooKassa/ЮKassa). See `docs/billing-provider.md` for the
full design (checkout-session security model, webhook verification,
idempotency, what still requires production credentials). In short:
`src/server/billing/checkout.ts#createCheckoutSession` creates a
`BillingCheckoutSession` row server-side (amount from `plans.ts`'s
catalog, never client input) *before* calling the vendor, and
`src/server/billing/webhook-events.ts#applySubscriptionWebhookEvent`'s
checkout-driven path grants exactly that row's `targetPlanId` once the
vendor's webhook confirms the payment — never a plan the webhook body
itself claims. While `BILLING_PROVIDER=none` (still the default), the
Billing UI continues to show "Payment not connected yet" and the checkout
path is unreachable, exactly as before.

## Billing UI (Settings → Billing)

Every member can view the tab (unchanged Phase 11.3 policy — plan/usage
transparency for the whole team, not just the OWNER); only an OWNER sees
the mutating actions, enforced twice: `role !== "OWNER"` hides the buttons
in the render, and `requireOrganizationRoleForPage(orgSlug, "OWNER")`
inside every Server Action (`billing-actions.ts`) is the actual boundary —
the render-time check is a convenience, not the enforcement.

Shown: current plan + price, subscription status (with `EXPIRED`/`CANCELED`
distinguished), billing period, usage (customers/invoices/members/AI
generations/Copilot requests), capabilities (Collections Automation/
Copilot/Wallet/Integrations, each reflecting the real entitlement), full
plan comparison (all four plans, real prices, real limits), real payment
history (empty and honest when no real provider is connected), and the
change-plan section described above.

## Product value dashboard — "PAYNORA Financial Impact"

Added to Overview → Today (`src/app/app/[orgSlug]/page.tsx`), directly
under the existing "Today" section header and before the existing detail
grid — not a new, disconnected dashboard. Every number is read from data
the page already loads for that same render (`attention`, `dailyBrief`,
`summary`) — zero new queries:

- **N invoices need attention** — `attention.filter(reason === "overdue").length`.
- **Currently overdue** — `summary`'s own `totalOverdueMinor` for the
  primary currency (the same figure the existing "Overdue Amount"
  `MetricCard` below shows, surfaced here as a headline stat rather than
  duplicated logic).
- **N cash-flow risk windows** — `dailyBrief.cashFlowRiskWindows.filter(isPotentialRisk).length`.
- **N actions ready to review** — `dailyBrief.recommendedActionsCount`
  (already `= listPendingActionProposals(...).length`).

**Deliberately never a claimed-savings/ROI figure** ("PAYNORA saved
₽184,000") — the system has no way to prove a counterfactual. Every stat
here is a fact already computed by an existing, tested function, presented
as a fact ("N invoices need attention"), never an inference the product
cannot back with real data.

## Deliberate non-gates

Two things this phase's brief listed as candidate entitlement dimensions
were deliberately **not** newly restricted, and that is a documented
decision, not an oversight:

- **Action Center** — the core approve/dismiss reminder workflow is
  available on every plan. Gating it would break the product's core value
  loop for exactly the FREE-tier users who most need to experience it
  before upgrading. It is already indirectly bounded by the customer/
  invoice/AI-generation limits (fewer detected events on a smaller plan
  naturally means fewer proposals) — no separate flag was needed or added.
- **Proactive Intelligence (Daily Brief, attention score, cash-flow risk)**
  — the deterministic computation is free (no AI cost, no external call) and
  is exactly the "prove PAYNORA's value" surface section 8/9 of this
  phase's brief asks to feature prominently; gating it away from FREE users
  would undermine that goal. Only the *AI-elaboration* nicety on top of it
  (Copilot's rewording) is gated, via `copilotEnabled` — the deterministic
  core stays available to every plan.

## Security / entitlement bypass audit

Scenarios checked (Phase 19 brief section 10), each with a concrete
mechanism, not just a claim:

1. **MEMBER reaching OWNER-only billing functionality** — every mutating
   Server Action in `billing-actions.ts` calls
   `requireOrganizationRoleForPage(orgSlug, "OWNER")` as its first line;
   this throws (404s) regardless of how the action is invoked — through the
   rendered UI or a direct POST to the action endpoint. The UI's `isOwner`
   check is a convenience only.
2. **Organization A reading organization B's usage/subscription** — every
   new function (`getOrganizationUsageOverview`, `getBillingPeriod`,
   `getOrganizationSubscriptionPayments`, `getCopilotUsage`) takes a
   pre-authorized `organizationId` and is only ever called with the id
   resolved by `requireOrganizationMembershipForPage`/
   `requireOrganizationRoleForPage` at the page/action boundary — the same
   layered-auth pattern every other domain function in this codebase
   already uses. None of these functions accept a client-supplied
   organization id directly.
3. **A user manually substituting a plan client-side** — every
   `assert*Entitled`/`getOrganizationEntitlements` call re-reads the
   subscription from Postgres inside the function itself; nothing is ever
   trusted from a request body or client state. `changeOrganizationPlanSelfServe`
   fetches `current.plan` from the database before comparing ranks — a
   crafted `targetPlan` argument still cannot produce an upgrade, because
   the *current* plan it's compared against is never client-supplied.
4. **Calling a Server Action directly, bypassing the UI** — Next.js Server
   Actions enforce their own logic regardless of invocation path; the
   `requireOrganizationRoleForPage` gate and the `planRank` comparison run
   exactly the same whether the action is reached via a rendered button or
   a raw POST.
5. **An expired subscription using a PRO feature** — `deriveEffectiveStatus`
   computes `EXPIRED` fresh from `trialEndsAt` vs. `now` on every single
   `getOrganizationEntitlements` call; there is no caching layer to
   invalidate and no window where a stale TRIALING status keeps granting
   access after `trialEndsAt` passes.
6. **Bypassing a usage counter** — resource counts are live `COUNT`
   queries; AI-generation and Copilot counters are Postgres-backed atomic
   upserts (`checkRateLimit`'s `INSERT ... ON CONFLICT ... DO UPDATE`,
   proven correct under real concurrent calls in
   `src/server/rate-limit/service.test.ts`) — no client-reachable code path
   resets or forges either.

**Targeted tests added** (not exhaustive combinatorics, the specific
scenarios above): `entitlements.test.ts` (EXPIRED-trial derivation,
Copilot/Wallet gate pass/deny per plan, billing period provider-vs-derived,
Copilot usage tenant isolation), `subscription.test.ts` (new — downgrade
allowed, upgrade always rejected regardless of starting plan, cancel/
reactivate tenant isolation, reactivate-only-from-CANCELED guard),
`payment-history.test.ts` (new — tenant isolation), and updated
`copilot/service.test.ts` / `wallet/wallets.test.ts` (FREE-plan denial,
entitled-plan success, no wallet row written on a denied attempt).

**One considered, unchanged policy**: Billing tab visibility (plan, usage,
payment history) remains open to every organization member, not just the
OWNER — a continuation of the Phase 11.3 decision, not a new exposure this
phase introduced. Only mutations are OWNER-gated.

## Tests

`entitlements.test.ts` (+16 tests), `subscription.test.ts` (new, 11 tests),
`payment-history.test.ts` (new, 4 tests), `copilot/service.test.ts` (+1
gate test, all 9 existing tests updated to a Copilot-entitled fixture),
`wallet/wallets.test.ts` (+2 gate tests, all existing tests updated to a
Wallet-entitled fixture) — plus fixture fixes in `wallet/test-fixtures.ts`,
`wallet/balances.test.ts`, `wallet/payment-requests.test.ts` (three more
files that called the now-gated `connectWallet` through a default FREE-plan
organization). All real database tests against `paynora_test`, no mocked
business logic.

## What remains explicitly out of scope for this phase

Per the brief: no real `BillingProvider` adapter (Stripe/YooKassa), no real
payment collection, no real API keys, no vendor-plan-id mapping. The next
phase ("REAL PRODUCTION INTEGRATIONS") is where those land, on the founder's
explicit go-ahead — this phase deliberately stops at "the commercial
product layer is real and provider-neutral," not "money actually moves."

**Update (Phase 20)**: the YooKassa gap above is closed — a real adapter,
real checkout flow, and real webhook-driven plan grants now exist (still
requiring real production credentials to actually move money; see
`docs/billing-provider.md`). Stripe remains recognized-but-unimplemented,
and recurring/auto-billing (a saved payment method charged automatically
each period) is still explicitly out of scope — see that doc's
"what Phase 20 does not do" section.
