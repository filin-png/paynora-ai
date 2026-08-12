# PAYNORA AI

PAYNORA AI is a vertical SaaS for small B2B service businesses (2–30
employees) that helps them track accounts receivable, spot payment risk
early, and automate collection follow-up — without replacing the accounting
software they already use.

**Project status: Phase 8 — Production Communications & AI.**
Authentication, organizations, tenant isolation, customers, invoices,
payments, and a real AR dashboard are implemented (Phase 1–2). Phase 3
added an event → insight → proposal → human-approval pipeline (an Action
Center that proposes payment reminders for overdue invoices) and a
provider-agnostic AI Gateway. Phase 4 carries an approved proposal the
rest of the way to a real sent email — but **approval never sends
anything by itself**: a human reviews an editable draft and clicks Send
as a separate, explicit step, and the UI is always honest about delivery
state (including "uncertain" when a provider outcome genuinely can't be
confirmed). Phase 5 adds a scheduling layer on top of all of that: a
tenant-configurable collections policy, and a `runAutomationTick` engine
that re-checks overdue invoices on a schedule and either prepares a
reminder for human review (the default) or — only if an organization
owner explicitly opts in — sends it through the exact same Phase 4 send
path. **A schedule is never permission to send**: every tick re-verifies
live financial state, and automation is disabled by default at both the
deployment and organization level. Phase 6 extends the provider
architecture beyond AI/Email: bounded AI routing with a real OpenRouter/
Mistral fallback pair, a new `MessagingProvider` boundary with a real
Telegram adapter (no domain caller wired in yet), and a `BillingProvider`
type/contract for PAYNORA's own future subscription billing — plus a
cross-cutting provider registry, deployment-profile metadata, and a
secret-free telemetry boundary, all with **no new Prisma schema and no
new external credential required to run the app.** Phase 7 is a
UI-only pass: every screen was redesigned around a small reusable
design system and a restrained "premium financial control system"
visual identity (navy/graphite navigation, one indigo accent, semantic
color reserved for real financial meaning), with real empty/loading/
error/not-found states, verified responsiveness (390–1440px, zero
horizontal overflow), and a zero-violation accessibility pass — while
every domain function underneath stayed exactly what Phase 1–6 already
built and tested. Phase 8 turns the Phase 3/4/6 foundations into a real
production-oriented communication pipeline: Telegram gets its first real
domain caller as a second, first-class channel alongside Email (explicit,
non-silent channel selection — never a guess between the two); the
AI/Email/Messaging gateways gained real request cancellation on timeout
(an `AbortController`, not just an abandoned local promise) and tightened
secret-redaction; Collections Automation's `AUTO_SEND` path now records
who actually triggered a send (`"USER"` vs. `"AUTOMATION"`) on the audit
trail; and every existing safety guarantee — idempotent sends, an
explicit `UNCERTAIN` state for an ambiguous delivery outcome that's never
auto-retried, AI that can never set who a message goes to or how much is
owed — now applies to both channels identically, proven with tests, not
just asserted. **The test environment still requires zero real API
credentials.** See
[docs/product-ui.md](./docs/product-ui.md),
[docs/integration-architecture.md](./docs/integration-architecture.md),
[docs/collections-automation.md](./docs/collections-automation.md),
[docs/communications.md](./docs/communications.md),
[docs/operator-foundation.md](./docs/operator-foundation.md), and
[ROADMAP.md](./ROADMAP.md) for what's next.

## Tech stack

- **Frontend/Backend**: Next.js (App Router), React, TypeScript (strict mode)
- **UI**: Tailwind CSS v4, a small hand-built design system
  (`src/components/ui/`), `lucide-react` icons — no component-library
  dependency; see [docs/product-ui.md](./docs/product-ui.md)
- **Database**: PostgreSQL via Prisma — User, Organization, OrganizationMember,
  Customer, Invoice, Payment, ActivityEvent, BusinessEvent, OperatorInsight,
  ActionProposal, Communication, DeliveryAttempt, CollectionPolicy,
  CollectionPolicyStep, CollectionSequence, CollectionStepExecution
- **Auth**: Auth.js v5 (Credentials + JWT sessions), bcrypt password hashing
- **Money**: integer minor units as `BigInt` — never floating point; see
  [docs/accounts-receivable.md](./docs/accounts-receivable.md)
- **AI**: provider-agnostic Gateway (`AI_PROVIDER=none` by default, no
  credentials required to run the app); see
  [docs/ai-architecture.md](./docs/ai-architecture.md)
- **Email**: provider-agnostic Gateway over SMTP (`EMAIL_PROVIDER=none` by
  default, no credentials required to run the app or draft/preview
  reminders); see [docs/communications.md](./docs/communications.md)
- **Messaging**: provider-agnostic Gateway with a real Telegram adapter
  (`MESSAGING_PROVIDER=none` by default; no domain feature calls it yet —
  a foundation, see [docs/integration-architecture.md](./docs/integration-architecture.md#messaging))
- **Billing**: `BillingProvider` type/contract for PAYNORA's own
  subscription billing (`BILLING_PROVIDER=none` by default; no real
  Stripe/YooKassa adapter yet, no Prisma schema — see
  [docs/integration-architecture.md](./docs/integration-architecture.md#billing))
- **Validation**: Zod
- **Testing**: Vitest, including real-database tenant-isolation and
  concurrency tests
- **CI**: GitHub Actions

The project is a modular monolith on purpose — see
[ARCHITECTURE.md](./ARCHITECTURE.md) for the reasoning and the boundaries
that keep it from becoming a ball of mud as features are added.

## Development environment constraint

This project is developed from Russia. The local development and testing
workflow must never require a foreign bank card, Stripe, OpenAI, Anthropic,
Vercel, Clerk, or another foreign commercial service that may be
inaccessible. External capabilities (AI, email, payments, storage,
background jobs) are — or will be — isolated behind provider interfaces so
implementations can be swapped without touching business logic. See
[docs/provider-strategy.md](./docs/provider-strategy.md).

## Getting started

Requirements: Node.js 22+, npm, a local PostgreSQL (free — see
[DEPLOYMENT.md](./DEPLOYMENT.md)).

```bash
npm install
cp .env.example .env.local
# then fill in AUTH_SECRET (openssl rand -base64 33) in .env.local —
# DATABASE_URL's default already matches docker-compose.yml
docker compose up -d postgres   # or point DATABASE_URL at any local Postgres
npx prisma migrate dev
npm run dev
```

The app boots at http://localhost:3000. See
[docs/identity-and-tenancy.md](./docs/identity-and-tenancy.md) for the
authentication/tenancy design and exactly what's required to run it
locally, including the separate test database integration tests use.

## Scripts

| Script                | Purpose                                   |
| ---------------------- | ------------------------------------------ |
| `npm run dev`          | Start the Next.js dev server               |
| `npm run build`        | Production build                           |
| `npm run start`        | Run the production build                   |
| `npm run lint`         | ESLint (Next.js + TypeScript rules)        |
| `npm run typecheck`    | `tsc --noEmit`, strict mode                |
| `npm run test`         | Run the Vitest suite once (needs Postgres) |
| `npm run test:watch`   | Run Vitest in watch mode                   |
| `npm run db:validate`  | Validate `prisma/schema.prisma`            |
| `npm run db:generate`  | Generate the Prisma client                 |

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system structure and boundaries
- [ROADMAP.md](./ROADMAP.md) — phased build plan and current status
- [CHANGELOG.md](./CHANGELOG.md) — what actually shipped, by date
- [SECURITY.md](./SECURITY.md) — security baseline and reporting
- [DEPLOYMENT.md](./DEPLOYMENT.md) — local and future deployment setup
- [docs/identity-and-tenancy.md](./docs/identity-and-tenancy.md) — auth, tenancy, authorization design
- [docs/accounts-receivable.md](./docs/accounts-receivable.md) — money representation, invoice lifecycle, concurrency
- [docs/operator-foundation.md](./docs/operator-foundation.md) — event → insight → proposal → approval pipeline
- [docs/communications.md](./docs/communications.md) — draft → review → send email, delivery semantics, idempotency
- [docs/collections-automation.md](./docs/collections-automation.md) — collection policies, scheduling, catch-up, auto-send safety
- [docs/domain-model.md](./docs/domain-model.md) — core domain entities
- [docs/ai-architecture.md](./docs/ai-architecture.md) — AI provider abstraction
- [docs/provider-strategy.md](./docs/provider-strategy.md) — external provider boundaries
- [docs/integration-architecture.md](./docs/integration-architecture.md) — Phase 6 cross-cutting provider registry, AI routing, Messaging, Billing
- [docs/product-ui.md](./docs/product-ui.md) — Phase 7 design system, page architecture, responsive/accessibility approach
- [docs/exit-readiness.md](./docs/exit-readiness.md) — commercial/due-diligence tracking
