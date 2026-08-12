# Roadmap

Status reflects what is actually implemented and verified, not what is
planned. Do not read a phase as "done" until its checklist is fully
checked and the acceptance gate (typecheck, lint, test, build) passed on
the commit that closes it.

## Phase 0 — Foundation — ✅ complete (2026-08-10)

- [x] Next.js + TypeScript (strict mode) application that boots with `npm run dev`
- [x] Tailwind CSS + shadcn/ui-compatible component architecture (`src/components/ui`)
- [x] PostgreSQL/Prisma toolchain configured (no domain models yet — Phase 1)
- [x] Zod-based environment validation (`src/lib/env.ts`), nothing required to boot
- [x] ESLint (Next.js + TypeScript rules) clean
- [x] Vitest configured with a real passing test suite
- [x] GitHub Actions CI (typecheck, lint, test, build)
- [x] Baseline documentation (this set of files)
- [x] No paid or foreign-only service required to run the dev workflow

## Phase 1 — Identity & Multi-Tenancy — ✅ complete (2026-08-10)

- [x] Authentication (Auth.js v5, Credentials provider, JWT sessions, bcrypt)
- [x] Organization model + creation flow (transactional: org + OWNER membership)
- [x] Organization membership (`OWNER` / `MEMBER`, unique per user+org at the DB level)
- [x] Server-side authorization on every query/mutation (`src/server/tenancy/context.ts`)
- [x] Tenant isolation enforced at the data-access layer (slug → membership lookup, never trusted from the client)
- [x] Automated tenant-isolation tests (Org A cannot read/write Org B's data) — real-database tests, see `docs/identity-and-tenancy.md#testing`

See `docs/identity-and-tenancy.md` for the full design.

## Phase 2 — Accounts Receivable Core — ✅ complete (2026-08-10)

- [x] Customer CRUD + archive (archiving never affects existing invoice/payment history)
- [x] Invoice CRUD with amount (integer minor units, `BigInt`), currency, issue/due date, outstanding amount (derived, not persisted)
- [x] Payment recording — full, partial, multiple payments; overpayment safely rejected under real concurrency (row-level lock, tested with concurrent requests)
- [x] Invoice lifecycle: `OPEN`/`CANCELLED` persisted, paid/partially-paid/overdue derived — see `docs/accounts-receivable.md`
- [x] AR dashboard: total outstanding, total overdue, open/overdue counts, recent payments, invoices requiring attention — grouped by currency, real persisted data only
- [x] Activity timeline per customer/invoice, tenant-isolated
- [x] Deterministic (non-AI) "requires attention" definition — overdue, then due-soon

See `docs/accounts-receivable.md` for the full design, including the money
representation, currency model, and concurrency strategy.

## Phase 3 — Operator Foundation — ✅ complete (2026-08-11)

- [x] `AIProvider` interface + provider-agnostic AI Gateway (`generateStructured<T>`, timeout, Zod-validated output, normalized errors)
- [x] `AI_PROVIDER=none` default — app boots and Operator runs with zero AI credentials
- [x] Deterministic `INVOICE_OVERDUE` event detector, idempotent, reusing Phase 2's overdue logic (no duplication)
- [x] `BusinessEvent` → `OperatorInsight` → `ActionProposal` pipeline, every step idempotent at the DB level
- [x] Deterministic LOW/MEDIUM/HIGH priority; AI (when enabled) may only affect display wording, never priority or any financial field
- [x] Prompt-injection defense: system instructions structurally separated from business data, tested against an adversarial customer note
- [x] Server-side action-type allowlist (`SEND_PAYMENT_REMINDER` only) — AI can never introduce a new action type
- [x] Approval/dismissal workflow (`PENDING` → `APPROVED`/`DISMISSED` only), tenant-scoped, idempotent, audited via `ActivityEvent`
- [x] Action Center UI (`/app/[orgSlug]/actions`) — honest about state, never claims something was sent
- [x] Manual "Run Operator" entry point — no cron/queue infrastructure
- [x] GigaChat adapter — **not implemented**; deferred until a phase actually needs a real provider (see `docs/provider-strategy.md`)
- [x] Reminder generation/sending, collection sequences, actual message delivery — **not implemented**, Phase 4

See `docs/operator-foundation.md` for the full design, including exactly
what was deliberately left out and why.

## Phase 4 — Communications Foundation + Email Execution — ✅ complete (2026-08-11)

- [x] `Communication`/`DeliveryAttempt` domain, additive migration, tenant-scoped like every other resource
- [x] `EmailProvider` interface + provider-agnostic Email Gateway (timeout, normalized errors, no `if (providerName)` branching in the domain)
- [x] `EMAIL_PROVIDER=none` default — app boots, and drafting/preview/editing all work with zero email credentials
- [x] SMTP adapter (`src/server/email/providers/smtp.ts`, via `nodemailer`) — works with any relay, not one vendor's API; no account created, no key invented
- [x] Approval still only changes status — draft preparation, review/edit, and an explicit Send are three separate, later steps
- [x] Deterministic reminder draft (recipient/subject/body from Phase 2 AR facts); AI (when enabled) may only affect subject/body wording, schema-validated, with a deterministic fallback
- [x] Prompt-injection defense for email wording, mirroring Phase 3's pattern
- [x] Two-phase send (atomic DB claim, then an out-of-transaction provider call, then a second transaction recording the outcome) — no naive `BEGIN; provider.send(); COMMIT`
- [x] Honest three-way outcome: `SENT` (confirmed), `FAILED` (definite rejection), `UNCERTAIN` (timeout/unrecognized error — never treated as a confirmed failure, never auto-retried)
- [x] `ActionProposal.EXECUTED` reachable, set only on a confirmed successful send; `FAILED` remains unreachable by design (failure belongs to the Communication/DeliveryAttempt history)
- [x] Concurrency closed and tested: Send vs. Send, Send vs. Edit, Retry vs. Retry — same atomic-conditional-update technique as Phase 3's approval fix
- [x] Header-injection defense (CR/LF rejected in subject), length limits, plain-text-only, no arbitrary-recipient relay
- [x] Action Center extended (`/app/[orgSlug]/actions/[proposalId]`) — review, edit, send, honest delivery-state display, retry/resend-with-acknowledgement
- [x] Full end-to-end test (overdue → Operator → approve → draft → send → SENT → proposal EXECUTED) with a deterministic fake provider — zero real email network calls anywhere in CI
- [x] Collection sequences, background job scheduling, automation controls — **not implemented**, Phase 5

See `docs/communications.md` for the full design, including exactly what
was deliberately left out and why.

## Phase 5 — Collections Automation Engine — ✅ complete (2026-08-11)

- [x] Tenant-scoped `CollectionPolicy`/`CollectionPolicyStep`, versioned so editing steps never retroactively changes an in-flight sequence
- [x] `CollectionSequence` per invoice, snapshotting the policy's version at enrollment; strict state machine (`ACTIVE`/`PAUSED`/`COMPLETED`/`STOPPED` with typed stop reasons)
- [x] Idempotent, lazy invoice enrollment (bulk-query, no per-invoice cron rows) — scales to future bulk import without special-casing
- [x] `runAutomationTick(now, options)` — deterministic w.r.t. injected `now`, idempotent under repetition, tenant-safe, testable without a real cron
- [x] "Schedule ≠ permission to send": every tick re-verifies live financial state (paid/cancelled/archived/policy-disabled/blocked-by-uncertain-delivery) immediately before acting, never trusting what a previous tick decided
- [x] DB-backed worker-vs-worker invariant (`@@unique([sequenceId, stepId])`) — proven with a real concurrent-tick test, not just asserted
- [x] Safe catch-up: a scheduler gap executes only the single most-advanced due step, marking earlier ones superseded — never a reminder burst
- [x] Full payment self-heals the sequence to stopped; partial payment continues with live-recomputed outstanding, never a stale amount
- [x] `UNCERTAIN`/stuck-`SENDING` delivery blocks further automation on that invoice until a human resolves it — no "wait and send anyway" logic
- [x] Reuses Phase 3's Operator pipeline (`ensureInsightForInvoiceOverdueEvent`/`ensureReminderProposalForInsight`, the latter extended with an explicit tone) and Phase 4's Communication/send pipeline unchanged — no second Operator, no second email sender
- [x] `AUTO_SEND` implemented: OWNER-only opt-in, default off, composes only `approveActionProposal`/`sendCommunication` (no bypass, no direct provider call), with a pre-send financial re-check
- [x] Two independent kill switches (deployment-level `AUTOMATION_ENABLED` env flag, organization-level toggle) — automation is inert unless both are explicitly on
- [x] Vendor-neutral scheduler adapter (`POST /internal/automation/tick`), `AUTOMATION_CRON_SECRET`-authenticated, no client-suppliable tenant or execution time
- [x] `/app/[orgSlug]/automation` UI + invoice-level collections status — honestly distinguishes "engine implemented" from "scheduler configured"; a manual tick trigger exists only outside production, clearly labeled dev-only
- [x] 94 new tests (309 total in the suite) covering worker concurrency, payment/cancellation/partial-payment races, catch-up, repeated-tick idempotency, `UNCERTAIN` blocking, `AUTO_SEND` safety, scheduler auth, tenant isolation, and two full E2E scenarios — including a targeted adversarial pre-merge audit pass that found and closed a pause/kill-switch/mode-switch race in the `AUTO_SEND` dispatch path (see `docs/collections-automation.md#concurrency`)
- [x] An outbox/reconciliation strategy for the crash-after-provider-success gap documented in `docs/communications.md#delivery-semantics` — **still not built**, same accepted limitation as Phase 4, not reopened

See `docs/collections-automation.md` for the full design, including the
concurrency/race-condition reasoning and everything deliberately left out.

## Phase 6 — Integration & Provider Foundation — ✅ complete (2026-08-12)

- [x] `AIProvider` extended: bounded primary+fallback routing
      (`AI_PROVIDER`/`AI_PROVIDER_FALLBACK`, at most two attempts, never
      retried past a confirmed success), real OpenRouter + Mistral HTTP
      adapters (mocked-network tested, no real key in CI); GigaChat/Yandex
      AI recognized-but-unimplemented (clear typed error, not a silent
      no-op or a fictional adapter)
- [x] `MessagingProvider` boundary + real Telegram Bot API adapter
      (mocked-network tested) — mirrors `EmailProvider`'s exact shape; no
      domain call site wired in yet, the same "foundation before feature"
      precedent `AIProvider` itself started under in Phase 3
- [x] `BillingProvider` types/contract only (`verifyAndParseWebhook`,
      normalized `BillingSubscriptionStatus`, `WebhookEventIdentity` for
      webhook idempotency) — explicitly for PAYNORA's own subscription
      billing, distinct from AR/collections; no Prisma schema, no real
      Stripe/YooKassa SDK call (that's Phase 8, below)
- [x] Cross-cutting Provider Registry (`src/server/providers/`):
      configuration-derived health model (`HEALTHY`/`DISABLED`/`UNKNOWN`
      only — `DEGRADED`/`DOWN` reserved for a future live health-check,
      never a network probe with a real side effect), deployment-profile
      metadata (`RU`/`GLOBAL`/`LOCAL_TEST`, descriptive only, never
      enforced), and a secret-free structured telemetry boundary wired
      into every gateway (AI/Email/Messaging)
- [x] Storage/Accounting/CRM/Banking: documented as planned candidates
      only, zero TypeScript — no existing domain use case to justify code
      yet, per `docs/provider-strategy.md`'s "no adapter before the phase
      that needs it" rule
- [x] 47 new tests (378 total) covering routing/fallback bounds, secrets
      absent from every new adapter's errors, disabled/misconfigured
      providers, health-state and deployment-profile resolution, and
      gateway-level telemetry for success/failure/timeout across AI,
      Email, and Messaging
- [x] Zero Prisma schema changes — every new category is provider/type
      code only, consistent with `docs/provider-strategy.md`'s dead-code
      rule for anything with no current caller

See `docs/integration-architecture.md` for the full design, including the
status table distinguishing implemented-with-tests from
recognized-but-unimplemented from documented-only, and exactly why each
scope decision was made.

## Phase 7 — Intelligence

- [ ] Payment behavior analytics
- [ ] Promise-to-pay tracking, manual first, automatic extraction later
- [ ] Cashflow forecast (7 / 30 / 60 days)
- [ ] Risk scoring improvements
- [ ] Collection performance analytics

## Phase 8 — Monetization

- [ ] Subscription domain model (Prisma schema — not yet added; Phase 6
      deliberately stopped short of this, see
      `docs/integration-architecture.md#billing`)
- [ ] Real `BillingProvider` adapters (Stripe, YooKassa) — the interface
      and normalized contract already exist (`src/server/billing/`, Phase
      6); this phase adds the actual SDK calls and a real merchant account
      to test against
- [ ] Plans, usage limits, entitlements
- [ ] Subscription lifecycle (trial, active, past-due, cancelled) driven
      by real, verified `BillingProvider` webhooks

## Phase 9 — Integrations (only per validated customer demand)

- [ ] Accounting system integrations (candidates: local/regional + QuickBooks, Xero)
- [ ] Payment processor integrations for customer-facing collection (distinct
      from Phase 8's PAYNORA-subscription billing — candidates: Stripe once
      relevant, regional providers)
- [ ] Invoice import (CSV/XLSX)
- [ ] Object storage (S3-compatible, Yandex Object Storage) for the first
      feature that needs to store a file/document

## Phase 10 — Commercialization

- [ ] Landing page + pricing
- [ ] Onboarding flow
- [ ] Transactional communication
- [ ] Analytics funnel (candidate: PostHog, per `docs/provider-strategy.md`)
- [ ] Legal pages
- [ ] Support workflow

## Phase 11 — Exit Readiness

- [ ] Remove founder dependencies
- [ ] Complete operational documentation
- [ ] Security review
- [ ] Dependency/license review
- [ ] Financial exports
- [ ] Technical due-diligence package

See `docs/exit-readiness.md` for the commercial metrics this phase targets.
