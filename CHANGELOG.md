# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — Phase 6: Integration & Provider Foundation

- `src/server/providers/`: new cross-cutting module, not owned by any one
  category — `types.ts` (`DeploymentProfile`, `ProviderCategory`,
  `ProviderHealthStatus`, registry entry/snapshot types), `registry.ts`
  (`getProviderRegistrySnapshot()`, `resolveHealth()`,
  `getRecommendedVendors()`), `telemetry.ts`
  (`recordProviderTelemetry()` — a fixed, secret-free structured shape,
  `{category, provider, operation, result, durationMs, errorCode?,
  requestId?, organizationId?}`, enforced structurally by TypeScript, not
  just convention). Health is configuration-derived only — no live network
  probe anywhere in this phase, since a "check" that itself sends a real
  email or spends a paid AI call would be a side effect, not a check;
  `DEGRADED`/`DOWN` are defined but never produced today, reserved for a
  future real health-check mechanism. `DEPLOYMENT_PROFILE`
  (`RU`/`GLOBAL`/`LOCAL_TEST`) is purely descriptive metadata, never
  enforced against provider selection.
- `src/lib/env.ts` extended: `AI_PROVIDER` now recognizes `openrouter`/
  `mistral` (real adapters) alongside the existing `gigachat`/`yandex`
  (still unimplemented); new `AI_PROVIDER_FALLBACK` (optional, must differ
  from `AI_PROVIDER`), `OPENROUTER_API_KEY`/`OPENROUTER_MODEL`,
  `MISTRAL_API_KEY`/`MISTRAL_MODEL`, `MESSAGING_PROVIDER`
  (`none`/`telegram`), `TELEGRAM_BOT_TOKEN`, `BILLING_PROVIDER`
  (`none`/`stripe`/`yookassa`), `DEPLOYMENT_PROFILE`. All optional, safe
  defaults, cross-field validation (e.g. Telegram requires its token;
  OpenRouter/Mistral require their key+model whether selected as primary
  or fallback) — the app still boots with none of this set.
- `AIProvider` routing (`src/server/ai/service.ts`): `tryGenerateStructured`
  now tries at most two providers — the primary, then an optional distinct
  fallback — stopping at the first confirmed (schema-validated) success;
  never a longer chain, never retried past success. Two real vendor
  adapters, `src/server/ai/providers/openrouter.ts`/`mistral.ts`, both
  OpenAI-compatible HTTP adapters sharing one wire-level helper
  (`openai-compatible-chat.ts`), reading their API key/model lazily at
  call time (the SMTP-adapter pattern) and taking an injectable
  `fetchImpl` for fully mocked-network unit tests — no real key or network
  call anywhere in the suite. Errors from a non-OK HTTP response include
  only the status code, never the response body or `Authorization` header.
- `MessagingProvider` (`src/server/messaging/`): new category mirroring
  `EmailProvider`'s exact shape — `types.ts`/`errors.ts`
  (`MessagingDisabledError`/`MessagingConfigurationError`/
  `MessagingTimeoutError`/`MessagingProviderRejectedError`/
  `MessagingProviderUnknownError`)/`gateway.ts`
  (`dispatchMessage` — timeout + normalized outcome + telemetry)/
  `service.ts`/`providers/{none,fake,telegram}.ts`. The Telegram adapter
  is a real Bot API `sendMessage` HTTP adapter (mocked-fetch tested),
  classifying `error_code` 400/403 as a definite rejection and everything
  else (rate limits, 5xx, network failure) as an unknown outcome; never
  includes the request URL (embeds the bot token) in a thrown error. **No
  domain code calls this yet** — a provider foundation, the same
  "boundary before feature" precedent `AIProvider` itself started under in
  Phase 3.
- `BillingProvider` (`src/server/billing/`): normalized types/contract
  only — `BillingCustomerId`/`BillingSubscriptionId` (opaque),
  `BillingSubscriptionStatus` (a shared vocabulary vendor statuses
  normalize into), `WebhookEventIdentity` (the idempotency boundary a
  future billing domain must check against repeated webhook delivery),
  `NormalizedSubscriptionEvent`, and a single-method `BillingProvider`
  interface (`verifyAndParseWebhook`) that only verifies and normalizes —
  it must never itself change financial state. Explicitly distinct from
  AR/collections (Phase 2–5): this is what a PAYNORA organization pays
  PAYNORA, not what their own customers pay them. No Prisma schema, no
  real Stripe/YooKassa SDK call — selecting either resolves to a clear
  `BillingProviderNotImplementedError`, the same precedent as AI's
  `gigachat`/`yandex`. Real implementation is Phase 8 "Monetization," per
  `ROADMAP.md`.
- Telemetry retrofitted into every gateway
  (`ai/gateway.ts#runAIGeneration`, `email/gateway.ts#dispatchEmail`,
  `messaging/gateway.ts#dispatchMessage`) rather than left at the
  service-call-site level — the real choke point regardless of caller,
  recording success/failure/timeout with the correct `errorCode` for
  every outcome, additive with no behavior change to any existing error
  path.
- 47 new tests (378 total) covering: AI routing/fallback bounds via
  dependency injection (primary-succeeds-fallback-never-called,
  primary-fails-fallback-succeeds-exactly-once, bounded-attempts-both-
  fail, no-fallback-one-attempt, unimplemented-vendor-treated-as-failure,
  invalid-output-triggers-fallback, disabled-short-circuits); OpenRouter/
  Mistral/Telegram adapter request shape, response parsing, and
  secret-absent-from-error assertions against a mocked `fetch`; Messaging
  gateway/service parity tests mirroring Email's; Billing service
  disabled/not-implemented tests; provider registry health-state and
  deployment-profile-recommendation tests; `env.ts` cross-field validation
  for every new variable; gateway-level telemetry tests (success/failure/
  timeout, secrets and message content never appear in a logged line)
  across AI, Email, and Messaging.
- Zero Prisma schema changes and zero migrations in this phase — every new
  category is provider/type code only, consistent with
  `docs/provider-strategy.md`'s existing "no adapter before the phase that
  needs it, an interface with no caller is dead code" rule (applied here
  to justify *not* building a Subscription table, Storage/Accounting/CRM/
  Banking TypeScript files, or a real Stripe/YooKassa SDK integration yet).
- New `docs/integration-architecture.md` (the full Phase 6 design,
  including a status table distinguishing implemented-with-tests from
  recognized-but-unimplemented from documented-only); ARCHITECTURE.md,
  ROADMAP.md (new Phase 6, renumbering the former Phase 6–10 to 7–11),
  SECURITY.md, DEPLOYMENT.md, `docs/provider-strategy.md`, and
  `.env.example` updated to match.

### Added — Phase 5: Collections Automation Engine

- `CollectionPolicy`/`CollectionPolicyStep`/`CollectionSequence`/
  `CollectionStepExecution` Prisma models and an additive migration
  (Phase 1–4 migrations untouched), plus `Organization.automationEnabled`
  and ten new `ActivityEventType` values. Policy steps are versioned —
  editing a policy's steps writes a new version rather than mutating
  existing rows, and a `CollectionSequence` locks in the version it was
  enrolled under, so a policy edit never retroactively changes an
  in-flight sequence.
- `src/server/collections/policy.ts`: tenant-scoped policy CRUD, a
  single-default-policy selector, automation-mode switching
  (`APPROVAL_REQUIRED`/`AUTO_SEND`) that records the authorizing OWNER,
  and the organization-level automation kill switch — all OWNER-only.
- `src/server/collections/enrollment.ts`: idempotent, bulk-query lazy
  enrollment of eligible OPEN invoices — no per-invoice cron rows, no
  duplicate sequences under concurrent ticks.
- `src/server/collections/engine.ts`: `runAutomationTick(now, options)`,
  the scheduler-independent core. **Schedule ≠ permission to send** — every
  tick re-verifies live financial state, sequence status, policy
  enablement, and prior-communication safety immediately before creating
  or executing anything, never trusting a previous tick's decision.
  Deterministic relative to its injected `now` (threaded through as an
  optional `today` override on `getInvoiceWithFinancials`/
  `listInvoicesWithFinancials`/`buildDeterministicInvoiceContext` — a
  small, backward-compatible extension to Phase 2/4 code, not a fork of
  it). A DB-unique-constraint claim (`@@unique([sequenceId, stepId])`) is
  the sole worker-vs-worker concurrency invariant — no in-memory lock.
  Catch-up after a scheduler gap executes only the single most-advanced
  due step, marking earlier ones `SKIPPED` — never a reminder burst.
- Reuses Phase 3's Operator pipeline unchanged
  (`ensureInsightForInvoiceOverdueEvent`, now documented as intentionally
  event-type-agnostic) and extends `ensureReminderProposalForInsight`
  with an optional explicit `tone` parameter so a policy step's
  configured tone can drive a reminder instead of insight priority — the
  only change made to existing Phase 3 code. No second Operator was
  built.
- `AUTO_SEND` implemented: default off, OWNER-only opt-in per policy,
  composes only the existing `approveActionProposal` (Phase 3) and
  `prepareReminderCommunication`/`sendCommunication` (Phase 4) — no
  direct `EmailProvider`/`nodemailer` call anywhere in
  `src/server/collections/`, and a fresh financial re-check immediately
  before the send. `UNCERTAIN` or a stuck `SENDING` `Communication` on an
  invoice blocks all further automation on it, self-healing once a human
  resolves it — no "wait N days and send anyway" logic.
- `src/app/internal/automation/tick/route.ts`: the vendor-neutral
  scheduler adapter (`POST /internal/automation/tick`), authenticated via
  a constant-time-compared `AUTOMATION_CRON_SECRET` bearer token, no
  request body parsed (a global tick has no tenant a caller could spoof).
  New `AUTOMATION_ENABLED`/`AUTOMATION_CRON_SECRET` env vars, Zod-
  validated, safe defaults (disabled unless explicitly configured).
- `src/app/app/[orgSlug]/automation/`: kill switch, policy management,
  active-sequence list with pause/resume/stop, and a manual tick trigger
  rendered only outside production and explicitly labeled dev-only — the
  UI never claims "Automation running" as a statement about a real
  scheduler it cannot observe. Invoice detail page gets an honest
  collections-status block (active/paused/blocked-uncertain/completed/
  stopped).
- 94 new tests (309 total) covering policy validation, enrollment
  idempotency, worker-vs-worker concurrency, repeated-tick idempotency,
  catch-up, full/partial payment, cancellation, archived customer,
  policy-disabled, pause, `UNCERTAIN`/stuck-`SENDING` blocking, `AUTO_SEND`
  safety, scheduler authentication, tenant isolation, and two full E2E
  scenarios — zero real network calls, reusing Phase 4's fake email
  provider.
- Manually verified in a real browser end to end (see
  `docs/collections-automation.md#verification`).
- **Adversarial pre-merge audit** (a separate pass after the above,
  explicitly trying to break the implementation rather than confirm it):
  found and closed a real race in the `AUTO_SEND` dispatch path — an
  OWNER pausing a sequence, disabling organization automation, or
  switching a policy back to `APPROVAL_REQUIRED` in the window between a
  step's claim and the actual send was not being re-checked immediately
  before dispatch. Fixed with `isAutoSendStillAuthorized`
  (`src/server/collections/engine.ts`), mirroring the existing pre-send
  financial re-check. 22 new regression tests added for this and for
  other audited scenarios (stuck-CLAIMED non-blocking of later steps,
  `FAILED` non-blocking, exact day+20 four-step catch-up, partial-payment
  content verification, policy-version immunity end-to-end, audit-event
  deduplication under concurrency, additional tenant-isolation and
  forged-`now`/malformed-auth coverage) — see
  `docs/collections-automation.md#concurrency` for the full writeup. No
  other correctness or security issues found; the documented
  payment/cancellation race window (between the final pre-send check and
  the actual provider call) was re-examined and confirmed genuinely
  irreducible without either holding a transaction across the network
  call or building an outbox/reconciler — both explicitly out of scope.

### Added — Phase 4: Communications Foundation + Email Execution

- `Communication`/`DeliveryAttempt` Prisma models and their migration,
  tenant-scoped like every other resource, plus six new
  `ActivityEventType` values reusing the existing audit trail. A
  `Communication` is always tied 1:1 to the `ActionProposal` it was
  drafted for (`@unique` on `actionProposalId`).
- A provider-agnostic Email Gateway (`src/server/email/`), architecturally
  identical to Phase 3's AI Gateway: `EmailProvider.send()`, a timeout, four
  normalized error types, and a service layer that resolves the
  configured provider. `EMAIL_PROVIDER` defaults to `"none"`; the app
  boots and drafting/preview/editing all work with zero email
  credentials.
- An SMTP adapter (`src/server/email/providers/smtp.ts`, via
  `nodemailer`) as the one real transport — chosen specifically because
  SMTP itself is the swappable boundary (any relay, self-hosted or not),
  not a single foreign vendor's REST API. No account was created and no
  API key was invented; a deterministic fake provider
  (`src/server/email/providers/fake.ts`) is used only in tests, via a
  test-only dependency-injection point on `sendCommunication` — zero real
  email network calls anywhere in the suite or CI.
- `src/server/communications/`: `prepareReminderCommunication` (draft,
  idempotent, deterministic financial facts from Phase 2's AR domain via
  a new shared `src/server/ar/reminder-context.ts` — extracted from
  Phase 3's Operator context builder so both callers use one
  implementation), `updateCommunicationDraft` (subject/body editing,
  DRAFT-only, header-injection and length validation), and
  `sendCommunication` (the explicit, two-phase send).
- **Approval still only changes status.** Sending is a distinct, later,
  explicit action — reviewing a real editable draft and clicking Send.
- **No naive transaction around the provider call.** `sendCommunication`
  atomically claims the communication (`DRAFT`/`FAILED`/`UNCERTAIN`-with-
  acknowledgement → `SENDING`, plus a `PENDING` `DeliveryAttempt`) in one
  transaction that commits *before* calling the provider, then records
  the outcome in a second transaction — documented and reasoned through
  in `docs/communications.md#delivery-semantics`, including the accepted
  gap if the process crashes between a confirmed provider success and
  recording it.
- **Three honest outcomes, not two.** A definite provider rejection →
  `FAILED`. Anything else — timeout, network error, an unrecognized
  exception — → `UNCERTAIN`, never treated as a confirmed failure and
  never auto-retried; resending from `UNCERTAIN` requires an explicit
  `acknowledgeUncertainRisk` acknowledgement, surfaced in the UI as a
  separately-labeled, confirmation-gated "Resend anyway" action.
- `ActionProposal.EXECUTED` (reserved but unreachable since Phase 3) is
  now set — only by a confirmed successful send, never by approval and
  never by an ambiguous outcome. `FAILED` remains unreachable by design:
  failure/uncertainty belongs to the Communication/DeliveryAttempt
  history, which stays retryable, not to the proposal.
- Every race closed with the same atomic-conditional-update technique as
  Phase 3's approval fix, and proven with real concurrent-request tests:
  Send vs. Send (a double-click never causes two provider calls — proven
  by counting actual provider invocations), Send vs. Edit (whatever was
  actually dispatched always matches what's persisted, regardless of
  which one won), Retry vs. Retry.
- Email security: header-injection rejection (CR/LF in subject), length
  limits (200/10,000 chars), plain-text only, recipient always
  server-derived from `Customer.email` — never a form field, so this
  can't become an arbitrary-recipient relay.
- `Customer.email` (already existed, Phase 2) now normalizes the same way
  `User.email` does (trim + lowercase, reusing
  `src/server/auth/email.ts#normalizeEmail` rather than duplicating it).
- Action Center extended: `/app/[orgSlug]/actions/[proposalId]` — prepare
  a draft, review/edit, explicit Send, honest delivery-state display
  (`Sent [date]` / `Failed: <reason>` / `Delivery status uncertain — do
  not resend automatically`), delivery-attempt history. The main Action
  Center list now shows `EXECUTED` proposals as "Sent" and links
  `APPROVED` ones to the review/send page instead of a dead-end badge.
- 47 new automated tests (real Postgres, zero real email network calls)
  covering draft creation/idempotency, editing/validation, every send
  outcome (success/rejection/timeout/missing-config), tenant isolation,
  prompt-injection defense for email wording, all three concurrency
  races, and a full end-to-end pipeline test — 213 total across the
  project.
- New `docs/communications.md`; README, ARCHITECTURE, ROADMAP (Phase 4
  renamed to match what shipped; former Phase 4 leftovers — sequences,
  scheduling — moved to a new Phase 5), SECURITY, `docs/domain-model.md`,
  `docs/operator-foundation.md`, `docs/ai-architecture.md`, and
  `docs/provider-strategy.md` updated to match.
- `package.json` `overrides` added for `nodemailer` (pinned to a version
  with several fixed CVEs — CRLF/header-injection and SMTP-command-
  injection advisories, directly relevant to this phase's own
  header-injection defense) to resolve a peer-dependency conflict with
  `next-auth`'s optional (and unused — this project only uses the
  Credentials provider) `nodemailer` peer range; verified with a clean
  `npm ci` that the conflict is actually resolved, not just locally
  patched over.

### Fixed — Phase 3: Operator Foundation

- `approveActionProposal`/`dismissActionProposal` (`src/server/operator/approval.ts`)
  read a proposal's status, then updated it unconditionally in a separate
  step — two concurrent decisions on the same `PENDING` proposal (one
  approve, one dismiss) could both pass the initial check and both
  "succeed", with whichever update ran last silently overwriting the
  other's decision. Fixed with an atomic conditional update
  (`updateMany` with `WHERE status = 'PENDING'` in the same transaction
  as the audit event): Postgres serializes concurrent UPDATEs on the same
  row and re-evaluates the WHERE clause against the just-committed row
  under READ COMMITTED, so at most one of two concurrent calls can ever
  match and apply. The other now correctly rejects with
  `InvalidActionProposalTransitionError` instead of silently losing.
  Verified with a real concurrency test that fires concurrent
  approve/dismiss calls (including 8 repeated rounds) and asserts exactly
  one decision is ever recorded — confirmed to fail against the old
  implementation before the fix, not just pass against the new one.

### Added — Phase 3: Operator Foundation

- `BusinessEvent`, `OperatorInsight`, `ActionProposal` Prisma models and
  their migrations, plus two new `ActivityEventType` values
  (`ACTION_PROPOSAL_APPROVED`/`ACTION_PROPOSAL_DISMISSED`) reusing the
  existing audit trail instead of a new one. Every write is idempotent at
  the database level via unique constraints, not just an
  application-level check.
- A deterministic, tenant-scoped, idempotent `INVOICE_OVERDUE` event
  detector that reuses Phase 2's `computeInvoiceFinancials`/
  `listInvoicesWithFinancials` — it does not recompute overdue logic.
- The Operator pipeline (`src/server/operator/`): detect → deterministic
  context → analyze (deterministic + optional AI) → insight → proposal,
  driven by one function (`runOperator`) safe to call any number of times
  without duplicating anything.
- A provider-agnostic AI Gateway (`src/server/ai/`):
  `AIProvider.generateStructured<T>()`, Zod-validated structured
  request/response, a 10s timeout, four normalized error types, and a
  service layer that never throws — any AI failure degrades to a
  deterministic fallback. `AI_PROVIDER` defaults to `"none"`; the app
  boots and the Operator pipeline runs end to end with zero AI
  credentials. No real vendor adapter is implemented yet (see
  `docs/ai-architecture.md`); a deterministic fake provider
  (`src/server/ai/providers/fake.ts`) is used only in tests — zero real
  AI network calls anywhere in the suite or CI.
- Deterministic LOW/MEDIUM/HIGH priority (a pure function of days
  overdue) and a deterministic suggested reminder tone (a pure function of
  priority) — neither is ever asked of or overridable by AI, which may
  only affect an insight's summary wording.
- Prompt-injection defense: every AI request structurally separates
  fixed, operator-authored instructions from business data (which may
  include customer-authored free text) — tested against a concrete
  adversarial customer note (`src/server/operator/ai-context.test.ts`).
- A server-side action-type allowlist (`SEND_PAYMENT_REMINDER` is the
  only member in Phase 3) checked before every proposal is created — AI
  is never asked for and never validated to produce an action type.
- An approval/dismissal workflow (`PENDING` → `APPROVED`/`DISMISSED`
  only, same-state calls idempotent, everything else rejected), tenant-
  scoped and audited. Approving a proposal only changes its status —
  there is no execution path in Phase 3.
- Action Center UI (`/app/[orgSlug]/actions`): pending proposals with
  full context and Approve/Dismiss controls, a "Recently decided" list so
  a decision's outcome stays visible, and a manual "Run Operator" button
  — no cron or queue infrastructure. Honest about state throughout
  (an approved proposal reads "Approved — execution is not enabled yet",
  never "Sent").
- 49 new automated tests (real Postgres, zero real AI network calls)
  covering event detection and its idempotency, tenant isolation for all
  three new resources, the AI Gateway (valid/invalid/timeout/disabled/
  provider-failure), the approval state machine, prompt-injection
  defense, and full end-to-end pipeline idempotency — 164 total across
  the project.
- New `docs/operator-foundation.md`; `docs/ai-architecture.md` updated in
  place to describe what was actually built (not just the planned
  direction); README, ARCHITECTURE, ROADMAP, SECURITY (explicit trust-
  boundary chain), and `docs/domain-model.md` updated to match.

### Fixed — Phase 2: Accounts Receivable Core

- `cancelInvoice` now locks the invoice row (`SELECT ... FOR UPDATE`, the
  same lock `recordPayment` takes, extracted into a shared
  `lockInvoiceForUpdate`) and re-checks recorded payments only after
  acquiring that lock, instead of reading them before the transaction
  started. Previously, a payment recorded concurrently with a
  cancellation could commit after `cancelInvoice`'s initial (unlocked)
  check but before its status update, leaving a `CANCELLED` invoice with
  a payment against it. Both operations now serialize against each other
  correctly; whichever commits first determines the outcome, and the
  other is rejected (`InvoiceCancelledError` or the new
  `InvoiceHasPaymentsError`). Verified with a concurrency test that fires
  real concurrent `cancelInvoice`/`recordPayment` calls and asserts the
  invariant holds regardless of which one wins — see
  `docs/accounts-receivable.md#concurrency`.

### Added — Phase 2: Accounts Receivable Core

- `Customer`, `Invoice`, `Payment`, `ActivityEvent` Prisma models and their
  migration, including hand-added CHECK constraints (positive amounts,
  due date on/after issue date, currency format).
- Money represented as integer minor units stored as `BigInt` (Postgres
  `BIGINT`) — not the `Int` originally drafted, which was rejected during
  review as an artificial ~21.4M-major-unit cap unacceptable for a
  commercial product. `bigint` never crosses a Server Action/Client
  Component boundary; only formatted strings or raw form input do. See
  `docs/accounts-receivable.md#money-representation`.
- Currency as a validated 3-letter allowlist (`RUB`/`USD`/`EUR`) living on
  the invoice; `Payment` has no currency field of its own, eliminating a
  mismatch invariant by construction rather than checking it at runtime.
- Invoice lifecycle: only `OPEN`/`CANCELLED` persisted; paid, partially
  paid, and overdue are derived from amount, due date, and recorded
  payments — never a second, driftable source of truth.
- Outstanding balance computed live from persisted payments on every
  read, never stored as a mutable column.
- Business-date semantics (`@db.Date`, string comparison) for issue/due/
  paid dates, avoiding UTC/local timezone bugs in overdue determination.
- Concurrency-safe payment recording: `SELECT ... FOR UPDATE` row lock
  inside a transaction, so two payments recorded at the same time against
  the same invoice cannot jointly overpay it — verified with a test that
  fires two real concurrent requests, not just documented.
- Deterministic (non-AI) "invoices requiring attention": overdue, then due
  within 7 days.
- Append-only activity timeline, tenant-isolated, reused as-is by every
  Phase 2 entity and designed to extend to Phase 3+ automation events
  without a redesign.
- Customer and Invoice UI (list/create/detail/edit/archive; list/create/
  detail with filters and overdue indication), payment recording on
  invoice detail, and a real AR dashboard (org home page) — grouped by
  currency, no fabricated data, clean empty states. Org settings (members,
  rename) moved to `/app/[orgSlug]/settings` to make room for the
  dashboard as the org home page.
- 78 new automated tests (real Postgres) covering customer/invoice/
  payment CRUD and validation, tenant isolation for every Phase 2
  resource, currency grouping, date boundaries, and the payment
  concurrency race — 115 total across the project.
- New `docs/accounts-receivable.md`; README, ARCHITECTURE, SECURITY,
  DEPLOYMENT, and `docs/domain-model.md` updated to match.
- `tsconfig.json` target bumped to `ES2022` (from `ES2017`) — required for
  `BigInt` literal syntax; Node 22 supports it natively.

### Added — Phase 1: Identity & Multi-Tenancy

- Authentication via Auth.js v5 (Credentials provider, JWT sessions),
  bcrypt password hashing with timing-safe handling of unknown emails.
- `User`, `Organization`, `OrganizationMember` Prisma models and their
  first migration (`prisma/migrations/20260810183612_init_identity_and_tenancy`).
- Prisma driver adapter (`@prisma/adapter-pg`) — required by Prisma 7 for
  actual database connections, not just schema tooling.
- Transactional organization creation: creator becomes `OWNER` atomically,
  with a test proving no orphan organization survives a failed membership
  insert.
- Framework-agnostic authorization primitives (`requireUser`,
  `requireOrganizationMembership`, `requireOrganizationRole` in
  `src/server/tenancy/context.ts`) plus a thin Next.js redirect/404 layer
  (`src/server/tenancy/guards.ts`).
- Tenant context resolved from the URL slug and re-verified against
  database membership on every request — never trusted from a cookie or
  client-supplied value.
- Enumeration-safe error handling: nonexistent organization, existing
  organization you're not a member of, and wrong role all produce the same
  outcome (404 for pages).
- Minimal UI: `/sign-up`, `/sign-in`, protected `/app` shell, organization
  creation, and an organization page with member list and an OWNER-only
  rename form (the one role-gated operation this phase needed to exercise
  the model).
- 37 automated tests (Vitest against a real Postgres test database):
  password hashing, slug generation, registration/validation, organization
  creation and duplicate-membership rejection, and tenant isolation
  (member of Org A can't access Org B, unauthenticated access rejected,
  MEMBER rejected from the OWNER-only action).
- CI now runs a Postgres service container and applies migrations before
  running the test suite.
- New `docs/identity-and-tenancy.md`; README, ARCHITECTURE, SECURITY,
  DEPLOYMENT, and `docs/domain-model.md` updated to match.

### Added — Phase 0: Foundation

- Next.js (App Router) application with React 19 and TypeScript in strict mode.
- Tailwind CSS v4 and a shadcn/ui-compatible component convention
  (`src/components/ui`, `cn` helper, `components.json`), with a first
  `Button` component.
- Prisma toolchain configured for PostgreSQL (`prisma/schema.prisma`,
  `prisma.config.ts`); no domain models yet — introduced in Phase 1.
- Zod-based environment validation (`src/lib/env.ts`) with unit tests;
  nothing is required to boot the app in this phase.
- ESLint (Next.js core-web-vitals + TypeScript rules).
- Vitest test runner with a passing suite.
- GitHub Actions CI workflow running typecheck, lint, test, and build.
- Baseline documentation: README, ARCHITECTURE, ROADMAP, SECURITY,
  DEPLOYMENT, and `docs/` (domain model, AI architecture, provider
  strategy, exit readiness).
- Honest, minimal landing page describing the product mission — no fake or
  non-functional interactive elements.
