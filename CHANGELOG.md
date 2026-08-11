# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
