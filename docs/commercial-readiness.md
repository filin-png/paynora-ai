# Commercial Readiness (Phase 11.4)

What it takes for PAYNORA to accept a new real B2B user, guide them to
first value, and be evaluated by an external tester — without connecting
any paid external provider. See `docs/billing-entitlements.md` for the
plan/entitlement layer this phase builds its upgrade UX and readiness view
on top of, and `docs/integration-architecture.md` for the provider
abstractions the readiness view reads from.

## Onboarding

`src/server/onboarding/service.ts#getOnboardingState` derives six
first-run steps entirely from existing domain data — there is no separate
"onboarding" table and no fake completion flag:

1. **Create organization** — always complete; the organization exists.
2. **Add your first customer** — complete once `Customer.count > 0`
   (non-archived) for the org.
3. **Add your first invoice** — complete once any invoice exists.
4. **Review your receivables overview** — complete once at least one open
   invoice exists (the same signal the Overview dashboard itself uses).
5. **Review an Action Center recommendation** — complete once at least
   one `ActionProposal` exists for the org, regardless of its decision.
6. **Configure collections automation** — locked entirely unless the
   plan entitles it (`entitlements.collectionsAutomationEnabled`);
   complete once `Organization.automationEnabled` is true.

A step is `locked` (distinct from merely incomplete) when its prerequisite
isn't met yet (no customer → can't add an invoice) or the plan doesn't
entitle it. `isComplete` is true once every *achievable* step is done — a
step locked by plan never blocks the checklist from collapsing.

The UI (`src/app/app/[orgSlug]/onboarding-checklist.tsx`) is a
`<details>`-based card on the Overview page: expanded by default until
`isComplete`, collapsed by default afterward but always one click away.
No client JavaScript is used for the expand/collapse behavior.

## Sample data

`src/server/onboarding/demo-data.ts` lets an OWNER add (or remove) a small,
realistic set of fictional B2B customers and invoices — current, overdue,
partially paid, and paid in full — from Settings → General. It is:

- **Explicit**: only runs when an OWNER clicks a button; never automatic,
  never triggered on organization creation.
- **Tenant-scoped**: every query is scoped to the calling organization's id.
- **Marked**: every demo customer's email lives under the fixed domain
  `@demo.paynora.internal` — a plain, auditable fact about the record
  rather than a hidden flag, and the lookup key that makes seeding
  idempotent (a second call reports `already_seeded` and creates nothing).
- **Built on real domain functions**: `createCustomer`, `createInvoice`,
  and `recordPayment` — the same functions the manual UI forms call — so
  every plan-entitlement check, uniqueness constraint, and activity-log
  entry those already enforce applies to demo data too. No production
  invariant was relaxed to make seeding possible.
- **Reversibly removable**: "Remove sample data" archives the demo
  customers (`archiveCustomer`) and cancels their still-open, unpaid demo
  invoices (`cancelInvoice`) — never a hard delete. A demo invoice that
  already has a recorded payment is left alone, exactly like any other
  invoice with payment history: this codebase never deletes financial
  records, demo or not.

## Upgrade UX

`src/components/billing/plan-comparison.tsx` (`PlanComparison`) renders
FREE/STARTER/PRO side by side by reading `PLAN_ENTITLEMENTS`
(`src/server/billing/plans.ts`) directly — the same authoritative catalog
every server-side enforcement point reads. It appears in Settings →
Billing (with the organization's current plan highlighted) and, without a
current-plan highlight, on the public landing page's Plans section. No
plan limit is ever duplicated as a separate hardcoded UI value.

When a creation form (`customers/new`, `invoices/new`, invite-a-member)
hits `EntitlementLimitExceededError`, the existing error message already
states the limit and current usage; `src/components/billing/
upgrade-hint.tsx` additionally recognizes that message and renders a
"View plans →" link straight to Settings → Billing.

There is no checkout anywhere in this phase. Settings → Billing states
plainly: *"Online billing is not connected yet — plans are currently
managed by PAYNORA directly, and no payment method is required."* No
button claims to start a purchase.

## Product readiness / status

`src/server/onboarding/readiness.ts#getReadinessState` — surfaced as an
OWNER-only "Readiness" tab in Settings — summarizes five checks:

1. AI provider configured (via the existing provider registry)
2. Transactional email configured (via the existing provider registry)
3. Application base URL readiness (`APP_BASE_URL` not still `localhost`)
4. Collections automation entitlement (current plan)
5. Subscription/plan state

Every value comes from a primitive that already refuses to expose a
secret — `getProviderRegistrySnapshot` (never reads or returns a
credential, only whether one is present — see `registry.test.ts`'s
"never includes a secret value" proof) and `getOrganizationEntitlements`
(plan state, never a billing-provider secret). The one raw environment
read is `APP_BASE_URL`, a public origin, not a secret. No API key, secret
fragment, or raw environment variable is ever rendered — only booleans and
short human labels ("Configured" / "Not configured").

## Landing page

The existing landing page's visual identity, mockups, and section
structure are unchanged. This phase adds one new section — **Plans** —
between "Built to integrate" and "Security & control", reading
`PLAN_ENTITLEMENTS` directly (the same source Settings → Billing uses) so
the two can never drift apart. Every existing claim on the page was
re-checked against this phase's constraints: no claim of live AI
(`AI_PROVIDER` remains `none` by default), no claim of real email delivery,
no accounting integrations, no payment processing — the existing
"Built to integrate" section already draws this live-vs-architected line
honestly and needed no correction.

## What remains before PAYNORA can accept real external users

This phase does not connect any paid provider — that remains future work:

- A real `AI_PROVIDER` (OpenRouter or Mistral) with a funded API key, if
  AI-drafted reminders/insights are wanted from day one.
- A real `EMAIL_PROVIDER` (SMTP credentials) so reminder/invitation/
  password-reset emails actually deliver — today they no-op safely.
- `APP_BASE_URL` set to the deployment's real public origin — the
  Readiness tab flags this while it's still `localhost`.
- A real `BillingProvider` (Stripe/YooKassa) if self-serve plan changes
  and payment collection are wanted — today plan changes are a manual,
  PAYNORA-operated action (`setOrganizationPlan`).
- Deployment-level `AUTOMATION_ENABLED=true` plus a real scheduler calling
  the internal tick endpoint, if collections automation should actually
  run on a schedule rather than only via the manual "run now" action.

None of the above are code gaps — every one is a configuration/credential
step documented in `DEPLOYMENT.md`, deliberately left disconnected per
this phase's brief.
