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
      Stripe/YooKassa SDK call (that's Phase 9, below)
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

## Phase 7 — Premium Product Experience & Complete UI — ✅ complete (2026-08-12)

- [x] Restrained "premium financial control system" visual identity —
      navy/graphite navigation, one indigo accent, semantic color
      (green/amber/red) reserved for real financial meaning, light + dark
      palettes, `prefers-reduced-motion` respected globally
- [x] Original PAYNORA mark + wordmark (`src/components/brand/logo.tsx`,
      `app/icon.svg`) — no third-party logo or stock asset
- [x] Reusable design system (`src/components/ui/`): Button, Input,
      Textarea, Select, Switch, Label, Badge, Card, MetricCard, Table,
      EmptyState, Alert, Dialog, DropdownMenu, Tabs, Skeleton, Tooltip,
      StatusIndicator, PageHeader/SectionHeader — `class-variance-
      authority` for variants, native `<dialog>` for modals, no new UI
      dependency beyond `lucide-react` for icons
- [x] Full responsive app shell — navy sidebar + header on desktop,
      slide-out drawer below `lg` — with an org-scoped route group fix
      (`app/(no-org)/`) so `/app`'s minimal layout no longer nested
      inside the org sidebar shell (a real Next.js layout-nesting bug
      found and fixed, not cosmetic)
- [x] Rebuilt commercial landing page, split-panel auth pages, and a real
      onboarding flow (first-organization creation)
- [x] Rebuilt dashboard, Invoices, Customers, Action Center, Automation,
      and Settings (General/Members/Integrations/Billing/Security) UIs —
      every number and status is real data through existing Phase 1–6
      server functions, plus two new batched read helpers
      (`getCustomerReceivablesSummaries`, `getCollectionsBadgesForInvoices`)
      added specifically to avoid an N+1 query per list row
- [x] Action Center reframed around detect → recommend → review →
      approve/edit/reject/send, including a real fix for an unhandled
      crash when a proposal's customer has no email on file
- [x] Real empty/loading/error/not-found states everywhere — new
      `src/lib/not-found.ts#isResourceNotFoundError` recognizes every
      domain's not-found error class so pages render a real 404 instead
      of the generic error boundary
- [x] Verified responsive at 390/768/1024/1440px (zero horizontal
      overflow) and accessible (zero axe-core violations across ten
      pages after fixing one contrast issue and one unlabeled control —
      see `docs/product-ui.md#accessibility`)
- [x] Real-browser Playwright QA of the full golden path with zero real
      vendor network calls; 13 new targeted tests (391 total) covering
      the two new read helpers and the not-found classifier
- [x] Zero Prisma schema changes — this phase is UI/presentation only,
      every domain rule from Phase 1–6 is unchanged

See `docs/product-ui.md` for the full design system, page architecture,
responsive/accessibility approach, and known limitations.

## Phase 8 — Production Communications & AI — ✅ complete (2026-08-12)

- [x] AI (OpenRouter/Mistral) hardened for production: real
      `AbortController`-based request cancellation on timeout (a timed-out
      request's socket is now actually torn down, not just abandoned
      client-side), HTTP status classification (401/403/429/5xx) without
      ever logging a key, prompt, customer communication, or raw provider
      response body
- [x] AI routing's bounded fallback (primary → one optional, distinct-
      vendor fallback, never a longer chain) explicitly documented and
      tested as retryable/non-retryable-by-classification — see
      `docs/integration-architecture.md#ai-routing`; every `AIProvider`
      failure kind (timeout, provider/rate-limit error, invalid config,
      invalid output) is fallback-eligible because "fallback" here always
      means a different vendor/credential, never a resubmission to the
      same one
- [x] SMTP hardened: `connectionTimeout`/`greetingTimeout`/`socketTimeout`
      bound every phase of a stuck connection (SMTP is socket-based, so
      there is no `AbortSignal` the way the HTTP-based adapters take one)
- [x] Telegram wired as a real, second communication channel — Prisma
      schema extended (`CommunicationChannel.TELEGRAM`,
      `Customer.telegramChatId`/`preferredCommunicationChannel`),
      `sendCommunication`'s existing two-phase claim/dispatch/finalize
      state machine now branches on channel, inheriting every existing
      concurrency/idempotency/unknown-outcome guarantee for Telegram
      automatically — a Telegram chat id is never trusted as PAYNORA
      identity; every send is authorized server-side first
- [x] Explicit, non-silent channel selection
      (`src/server/communications/channel.ts#resolveCommunicationDestination`):
      auto-resolves only when exactly one destination is configured,
      otherwise reports `blocked: true` with a human-readable reason —
      never a silent guess between Email and Telegram
- [x] Collections Automation's `AUTO_SEND` path now threads a resolved,
      channel-appropriate provider and records `actorSource: "AUTOMATION"`
      on the audit trail (`ActivityEvent.metadata.source`) — a real gap
      found and fixed during this phase, since it previously defaulted
      silently to `"USER"` for automated sends
- [x] Idempotency boundary reused, not reinvented: `Communication
      .actionProposalId @unique` plus each collection step's own distinct
      `ActionProposal` already transitively guarantees at most one
      Communication per collection step, now channel-inclusive since
      channel is fixed once at draft time
- [x] Provider Settings UI (`/app/[orgSlug]/settings?tab=integrations`)
      shows real per-vendor configured/active status (OpenRouter, Mistral,
      SMTP, Telegram) — never a secret value, never an editable `.env`
      field
- [x] Dev-only live smoke-test CLI (`npm run smoke -- ai|email|telegram
      ...`) to manually verify a real vendor later — never runs in CI, no
      hardcoded recipient, requires `--confirm`, never prints a secret
- [x] Adversarial security review of this phase's surface (SSRF, header/
      CRLF injection, recipient spoofing, cross-tenant send, prompt
      injection, AI-controlled financial values, duplicate sends, retry-
      after-unknown-outcome, forged Telegram destination, secret/raw-
      response leakage) — no new exploitable finding beyond the
      `actorSource` audit gap above, which was fixed
- [x] 416 tests passing, including new coverage for the Messaging
      gateway's `AbortController` cancellation, Telegram end-to-end
      `AUTO_SEND`, and the AI routing fallback-eligibility policy

See `docs/communications.md` and `docs/integration-architecture.md` for
the full design, including what is real-network-verified vs. only
mock-tested so far.

## Production Hardening — ✅ complete (2026-08-12)

Not a numbered feature phase — a full adversarial audit was run against
the Phase 8 baseline (`docs/audits/PAYNORA-AUDIT-V1.md`), and this closes
every P0/P1 finding plus the related critical P2s
(`docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md` has the full per-finding
mapping to implementation/tests/limitations). Turns PAYNORA into a beta
candidate, not a finished product — see the remediation doc's honest
readiness assessment before treating any of this as "production-ready"
in an unqualified sense.

- [x] Postgres-backed auth rate limiting (IP + account) — enumeration-
      safe, fail-closed
- [x] Client-generated payment idempotency key, DB-enforced uniqueness
- [x] Deterministic post-generation safety check on AI-drafted reminders
- [x] Explicit confirmation UX for AUTO_SEND, the automation kill-switch,
      and first manual send
- [x] Recovery path for a `Communication` genuinely stuck at `SENDING`
- [x] Automation observability: heartbeat table + secret-free health
      endpoint
- [x] Bounded, cursor-based automation tick batching
- [x] Cursor-paginated invoices/customers/activity lists; new indexes
- [x] Org-scoped hourly limits on AI generation, sends, and operator runs
- [x] Decided and documented production hosting/DB-connection model
- [x] P2 batch: financial-invariant defense-in-depth, defensive caps on
      remaining lists, org-delete-cascade + backup/PITR docs, stale-doc
      fixes
- [x] One race condition found and fixed during this phase's own
      adversarial self-review (unconditional finalize writes racing
      stale-SENDING reconciliation) — see the remediation doc
- [x] 515+ tests passing (up from 416 at the Phase 8 baseline)

## A note on phase numbering below

The plan above (old "Phase 9 — Intelligence" through "Phase 13 — Exit
Readiness") described what came next as of the Production Hardening
milestone. What actually shipped afterward used different phase names and
numbers than that plan predicted — most of the *content* of the old plan
landed, just not under the names or in the order originally sketched
(e.g. cashflow forecasting and risk scoring shipped as part of "Phase 16",
not a "Phase 9"; a wallet/crypto-payments phase that wasn't on the old
plan at all became "Phase 13"). Rather than silently rewrite history, the
sections below record what was actually built, under the names actually
used in commits/docs at the time — this is deliberately not a clean
renumbering, because pretending the plan was followed exactly would be
less honest than showing where it diverged. `CHANGELOG.md`'s own phase
labels diverge further still in places (e.g. "Phase 10.2", "11.5", "11.6"
appear there but not below) — that file was not reconciled with this one
as part of this update; treat this ROADMAP as the index of what shipped
and `CHANGELOG.md` as a less rigorously maintained supplementary log.

## Phase 11.2 — Account Recovery & Invitations — ✅ complete

- [x] Password reset (token-based, rate-limited, single-use)
- [x] Organization invitations (email-based, role-preselected, expiring)
- [x] Transactional auth email sending helper
      (`src/server/email/transactional.ts`) — the same fire-and-forget,
      best-effort pattern every later transactional email (including
      Phase 17's support-request notification) reuses
- [x] Full test suite for both flows, including rate-limit and
      tenant-isolation coverage

See `docs/account-recovery-and-invitations.md`.

## Phase 11.3 — Billing & Entitlements Foundation — ✅ complete

- [x] `PlanId`/`SubscriptionStatus`/`OrganizationSubscription` schema —
      deliberately no price field yet ("no RUB/USD prices are required
      yet, do not make arbitrary pricing decisions" — this constraint is
      still honored as of Phase 17, see `docs/dependency-license-review.md`
      for where it mattered again)
- [x] Centralized plan-entitlements catalog
      (`src/server/billing/plans.ts`) — FREE/STARTER/PRO limits, one
      source of truth read by every enforcement point and by the landing
      page's Plans section
- [x] Enforcement across customers/invoices/members/AI generation/
      collections automation
- [x] CSV bulk-import quota safety

See `docs/billing-entitlements.md`. Real payment collection (Stripe/
YooKassa) is still not connected — see Phase 14 and "What's still open"
below.

## Phase 11.4 — Commercial Readiness — ✅ complete

- [x] Real, data-derived onboarding checklist (no fake completion flag)
- [x] Reversible sample/demo data mechanism, built on real domain
      functions (never a shortcut around normal validation)
- [x] Plan upgrade UX + plans comparison (landing page and in-app,
      reading the same `PLAN_ENTITLEMENTS` catalog)
- [x] OWNER-only product-readiness view (provider configuration status,
      never a secret value)
- [x] Landing page commercial pass

See `docs/commercial-readiness.md`, including its own honest "what remains
before PAYNORA can accept real external users" list.

## Phase 13 — Wallet Foundation (crypto payments) — ✅ complete

Not on the original plan above — added because a real customer-facing
payment channel (crypto wallets) became relevant before Stripe/YooKassa
did.

- [x] `Wallet`/`WalletTransaction`/`CryptoPaymentRequest` schema, tenant-
      scoped like every other resource
- [x] `WalletProvider` abstraction + reconciliation service (a detected
      on-chain transaction only ever marks an `Invoice` paid through the
      same `recordPayment` path manual entry uses — no parallel payment
      pipeline)
- [x] Webhook pipeline with signature verification and idempotent event
      handling
- [x] Native-asset (ETH) balance display, decimal-safe (Phase 15A
      extended this further — see below)

See `docs/wallet-architecture.md`.

## Phase 14 — Production Integrations & Real Intelligence — ✅ complete

- [x] Real `WalletProvider` adapter (Alchemy) and wallet webhook route
- [x] Real `WebSearchProvider` adapter + a bounded deep-research
      orchestrator
- [x] Real Analytics provider (PostHog), minimized to allowlisted event
      names — see Phase 15A for the privacy audit that followed
- [x] i18n foundation (RU/EN) — deliberately scoped to app-shell
      navigation and landing-page chrome, not a full-UI translation sweep
- [x] Production-facing environment management + `.env.example`,
      provider-failure observability

See `docs/production-integrations.md` for the full status table
(implemented-with-tests vs. recognized-but-unimplemented vs.
documented-only).

## Phase 15A — Native ETH Balances & Privacy/GDPR Foundation — ✅ complete

- [x] Multi-chain-aware `WalletBalance` type, decimal-safe native-asset
      handling
- [x] `docs/privacy-data-inventory.md` and `docs/data-flows.md` — an
      independently-verified inventory of what data goes where, which
      later documents (privacy policy, subprocessors list) are required to
      stay consistent with
- [x] Cookie consent mechanism (Settings → Privacy)
- [x] Foundation legal documents: `docs/privacy-policy.md`,
      `docs/terms-of-service.md`, `docs/data-retention.md`,
      `docs/subprocessors.md` — explicitly marked as a technical
      foundation with `[TO BE COMPLETED]`/`NEEDS LEGAL REVIEW` markers,
      not a finished legal instrument (Phase 17 below gave these documents
      live public pages; it did not remove those markers, since the
      underlying legal-entity/counsel gaps are still real)
- [x] Personal "export my data" / "delete my account" mechanism
      (deliberately scoped to the requesting user's own account, not
      organization financial records — see Phase 17's AR data export for
      the distinct, tenant-scoped counterpart to that scoping decision)

See `docs/privacy-data-inventory.md`, `docs/data-flows.md`.

## Phase 16 — Proactive Financial Operations — ✅ complete

- [x] Explainable 0–100 attention score (four weighted, disclosed
      factors — never a black-box number)
- [x] Three new deterministic detectors (payment received, invoice risk
      escalation, customer payment-behavior deterioration), feeding the
      existing Phase 3 Operator pipeline rather than a second one
- [x] Daily Brief aggregation, customer payment-delay trends, 3-week
      cash-flow risk windows (all computed fresh at read time — nothing
      persisted or trained)
- [x] Outcome/recommendation-effectiveness tracking, deliberately never
      a causal claim ("payment received after action," never "action
      caused the payment")
- [x] A small, fixed-question grounded Copilot (never free-text chat) —
      the deterministic building blocks it depends on are surfaced
      directly in the UI; a dedicated Copilot UI surface is not yet built
- [x] Full UI layer: Overview "Today" section, Action Center attention/
      stale display, invoice list priority badges, customer detail trend
      card

See `docs/proactive-financial-operations.md`.

## Phase 17 — Legal Pages, Data Export, Support, Dependency Review — ✅ complete

- [x] Live public legal pages (`/privacy-policy`, `/terms-of-service`,
      `/data-retention`, `/subprocessors`) rendering the Phase 15A
      foundation documents — previously only reachable by reading the
      repository, including a fix for a raw `docs/privacy-policy.md` path
      that had been shown verbatim, unlinked, in the product UI
- [x] Organization-level AR data export (CSV: customers/invoices/
      payments), tenant-scoped, OWNER-gated — the counterpart to Phase
      15A's personal account-data export, deliberately scoped the
      opposite way (this one *is* organization financial records,
      because it's an explicit, authorized org action, not a personal
      privacy-channel pull)
- [x] Founder-only, read-only subscription/plan report CLI — prints no
      revenue/MRR figure, honoring the Phase 11.3 "no arbitrary pricing"
      constraint since no real price or billing provider exists yet
- [x] Minimal support-request workflow (`SupportRequest` model, a form
      any member can use, best-effort email notification, audited via
      `ActivityEvent`) — no fake ticket-status UI
- [x] Dependency & license review (`docs/dependency-license-review.md`)
      — direct-dependency licenses are all permissive; the 5 high-severity
      `npm audit` findings all trace to Prisma's own dev-tooling
      dependency tree, none reachable from this app's deployed runtime,
      and the only automated "fix" available is a major Prisma
      *downgrade* — deliberately not applied

### Phase 18 — subscription-payment tracking (ingestion pipeline, no real adapter yet)

- [x] `SubscriptionPayment` ledger (`prisma/schema.prisma`) — one row per
      uniquely-processed `(provider, eventId)` billing webhook delivery;
      the idempotency boundary and audit trail for PAYNORA's own
      subscription payments
- [x] `applySubscriptionWebhookEvent` (`src/server/billing/webhook-events.ts`)
      — provider-independent, fully tested with hand-constructed events:
      resolves the organization from the verified event's customer/
      subscription id, writes the ledger row, and — only on an actual
      status transition — updates `OrganizationSubscription.status` and
      records a `SUBSCRIPTION_STATUS_CHANGED` `ActivityEvent`. Never
      writes `plan`: mapping a vendor's raw plan/price id to a PAYNORA
      `PlanId` needs real pricing first (see the open item below)
- [x] `NormalizedSubscriptionEvent` extended with optional `amountMinor`/
      `currency` — what a delivery reports as charged, never a value
      PAYNORA computes
- [x] `/api/webhooks/billing` route — one global endpoint (unlike
      Wallet's per-organization route: billing is the reverse shape, one
      PAYNORA merchant account with many organizations as its customers).
      Currently always returns 503 (`resolveBillingProvider()` still
      throws for both recognized vendor names) — the route's shape is
      real and tested so a real adapter is the only remaining step
- [x] Founder report (`report:subscriptions`) extended with a recent-
      payments table, sourced from real `SubscriptionPayment` rows only
      — empty until a real adapter exists, no fabricated figures

## What's still genuinely open (superseding the old Phase 9–13 plan above)

Everything below requires either a deliberate architectural decision, a
real external account/credential, or business action outside this
codebase — none of it is a small next step:

- **Real billing.** Phase 18 built the provider-independent ingestion
  pipeline (ledger, idempotent event application, webhook route) ahead of
  the vendor decision, but `BillingProvider` still has no real Stripe/
  YooKassa adapter, and the plan catalog still has no price — both are
  pending decisions, not implementation gaps. Self-serve plan changes and
  payment collection remain a manual, PAYNORA-operated action
  (`setOrganizationPlan`) until both land.
- **Real deployment.** `APP_BASE_URL` still defaults to `localhost`; no
  production deployment has been done from this codebase as of Phase 17.
- **Real AI/email credentials.** `AI_PROVIDER`/`EMAIL_PROVIDER` remain
  `none` by default; every AI-assisted or email-sending feature has been
  built, tested, and verified entirely through its deterministic
  fallback path, never against a live vendor.
- **Promise-to-pay tracking.** Never built, on the old plan or since.
- **Accounting/payment-processor integrations, object storage.** Still
  only documented candidates (`docs/provider-strategy.md`), per that
  doc's "no adapter before the phase that needs it" rule.
- **A completed legal instrument.** The Phase 15A/17 legal pages are
  real, live, and honest about being a *foundation* — the
  `[TO BE COMPLETED]`/`NEEDS LEGAL REVIEW` markers inside them (legal
  entity name, jurisdiction, counsel review) are still there because
  those facts don't exist yet, not because of an oversight.
- **Real customers and revenue.** `docs/exit-readiness.md` still shows
  Phase 0/pre-revenue as of this update — no phase above changes that;
  only paying customers do.
