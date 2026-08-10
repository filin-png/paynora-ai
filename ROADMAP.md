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

## Phase 3 — AI Collections

- [ ] `AIProvider` interface
- [ ] GigaChat adapter (first implementation)
- [ ] Structured, schema-validated AI output
- [ ] Reminder generation (Friendly / Professional / Firm / Custom tones)
- [ ] Deterministic payment-risk scoring (no ML infra yet)
- [ ] Graceful degradation when AI is unavailable

## Phase 4 — Collection Automation

- [ ] Collection sequences (e.g. due date → +3d → +7d → +14d)
- [ ] Background job scheduling (`JobProvider`)
- [ ] Idempotent reminder jobs (no duplicate sends on retry)
- [ ] `EmailProvider` + delivery
- [ ] Automation controls: global / per-customer / per-invoice disable
- [ ] Retries and observable permanent-failure states

## Phase 5 — Intelligence

- [ ] Payment behavior analytics
- [ ] Promise-to-pay tracking, manual first, automatic extraction later
- [ ] Cashflow forecast (7 / 30 / 60 days)
- [ ] Risk scoring improvements
- [ ] Collection performance analytics

## Phase 6 — Monetization

- [ ] Subscription domain model
- [ ] `BillingProvider` abstraction (no hard-coded Stripe)
- [ ] Plans, usage limits, entitlements
- [ ] Subscription lifecycle (trial, active, past-due, cancelled)

## Phase 7 — Integrations (only per validated customer demand)

- [ ] Accounting system integrations (candidates: local/regional + QuickBooks, Xero)
- [ ] Payment processor integrations (candidates: Stripe once relevant, regional providers)
- [ ] Invoice import

## Phase 8 — Commercialization

- [ ] Landing page + pricing
- [ ] Onboarding flow
- [ ] Transactional communication
- [ ] Analytics funnel
- [ ] Legal pages
- [ ] Support workflow

## Phase 9 — Exit Readiness

- [ ] Remove founder dependencies
- [ ] Complete operational documentation
- [ ] Security review
- [ ] Dependency/license review
- [ ] Financial exports
- [ ] Technical due-diligence package

See `docs/exit-readiness.md` for the commercial metrics this phase targets.
