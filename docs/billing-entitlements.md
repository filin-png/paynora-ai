# Commercial Plans & Entitlements (Phase 11.3)

Provider-neutral plan/subscription state and server-side usage enforcement,
built without connecting a real payment provider. See
`src/server/billing/types.ts` for the separate `BillingProvider` abstraction
(webhook verification only, no real adapter yet) this layer is designed to
sit underneath once one exists.

## Plan model

Three fixed plans — `FREE`, `STARTER`, `PRO` — defined in one place,
`src/server/billing/plans.ts` (`PLAN_ENTITLEMENTS`). Each entitlement is
either `{ kind: "limited", max: number }` or `{ kind: "unlimited" }`; nothing
represents "unlimited" as a magic number. Current values:

| | FREE | STARTER | PRO |
|---|---|---|---|
| Customers (non-archived) | 25 | 250 | Unlimited |
| Open invoices | 50 | 1000 | Unlimited |
| Organization members | 1 | 5 | 25 |
| AI generations / 30 days | 20 | 200 | 2000 |
| Collections Automation | Off | On | On |

These are product defaults for this phase, not final pricing — no
RUB/USD prices are attached anywhere in this layer.

## Subscription state

`OrganizationSubscription` (1:1 with `Organization`) stores `plan` and
`status` (`ACTIVE` / `TRIALING` / `PAST_DUE` / `CANCELED`), plus nullable
`billingProvider` / `externalCustomerId` / `externalSubscriptionId` columns
reserved for a future billing adapter — never written to by domain code in
this phase. Every organization gets a row at creation time
(`src/server/tenancy/organizations.ts#createOrganization`); organizations
that existed before this phase were backfilled to `FREE`/`ACTIVE` by the
Phase 11.3 migration.

### Status effects

`src/server/billing/entitlements.ts#getOrganizationEntitlements` derives
effective access from status:

- `ACTIVE`, `TRIALING`, `PAST_DUE` — the subscribed plan's entitlements
  apply. `PAST_DUE` is treated as a grace period rather than an immediate
  downgrade, since this phase has no payment provider or dunning process to
  decide when a grace period should end.
- `CANCELED` — reverts effective access to `FREE`. Existing data is never
  deleted; only new quota-consuming actions are bounded by `FREE`'s limits.

Plan/status changes are applied through
`src/server/billing/subscription.ts#setOrganizationPlan` — the only writer,
today reachable from tests/fixtures only (no checkout, no webhook).

## Enforcement

`assertWithinResourceLimit` (customers, invoices, members) and
`assertCanCreateInvitation` lock the `Organization` row for the duration of
their transaction, then count-then-create — the same row-locking idiom
already used for `Invoice` (`lockInvoiceForUpdate`). This serializes all
quota-consuming writes for one organization; a finer per-resource lock was
judged unnecessary at this product's scale.

Enforcement points:

- Customer/invoice creation (`src/server/ar/customers.ts`,
  `src/server/ar/invoices.ts`), including CSV bulk import
  (`src/server/ingestion/`), which stops attempting new creates the moment
  the quota is hit rather than reporting every remaining row as a separate
  failure.
- Invitation creation and acceptance (`src/server/tenancy/invitations.ts`)
  — creation checks members + pending invitations; acceptance is the
  authoritative check against actual membership rows.
- Collections Automation activation
  (`src/server/collections/policy.ts#setOrganizationAutomationEnabled`) and
  every tick/send (`src/server/collections/engine.ts`) — re-checked live, so
  a downgrade takes effect on an already-`automationEnabled` organization's
  very next tick with no extra migration step.

### AI quota vs. rate limit

`checkAiGenerationQuota` (`src/server/billing/entitlements.ts`) is a
commercial usage ceiling, deliberately distinct from the existing
per-hour abuse-protection rate limits (`src/server/rate-limit/policies.ts`'s
`aiGenerationPolicy`/`operatorRunPolicy`): the rate limit bounds how fast one
call site can spend AI budget regardless of plan; the quota bounds how much
a plan is entitled to spend at all. Both checks run, independently, at every
real AI call site (`src/server/operator/insights.ts`,
`src/server/communications/draft.ts`) before any provider is invoked — a
denied quota never makes an external call. The quota itself reuses the
existing `RateLimitCounter` table with its own scope and a 30-day window
(an approximation, not a calendar-month boundary), rather than a new table.

## Out of scope (this phase)

No payment provider, checkout, or webhook. No real prices. No admin pricing
CMS — the plan catalog is a single in-code config
(`PLAN_ENTITLEMENTS`), changed by editing `plans.ts`.
