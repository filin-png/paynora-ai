# PAYNORA AI

PAYNORA AI is a vertical SaaS for small B2B service businesses (2–30
employees) that helps them track accounts receivable, spot payment risk
early, and automate collection follow-up — without replacing the accounting
software they already use.

**Project status: Phase 4 — Communications Foundation + Email
Execution.** Authentication, organizations, tenant isolation, customers,
invoices, payments, and a real AR dashboard are implemented (Phase 1–2).
Phase 3 added an event → insight → proposal → human-approval pipeline (an
Action Center that proposes payment reminders for overdue invoices) and a
provider-agnostic AI Gateway. Phase 4 carries an approved proposal the
rest of the way to a real sent email — but **approval never sends
anything by itself**: a human reviews an editable draft and clicks Send
as a separate, explicit step, and the UI is always honest about delivery
state (including "uncertain" when a provider outcome genuinely can't be
confirmed). See [docs/communications.md](./docs/communications.md),
[docs/operator-foundation.md](./docs/operator-foundation.md), and
[ROADMAP.md](./ROADMAP.md) for what's next.

## Tech stack

- **Frontend/Backend**: Next.js (App Router), React, TypeScript (strict mode)
- **UI**: Tailwind CSS, shadcn/ui-compatible component architecture
- **Database**: PostgreSQL via Prisma — User, Organization, OrganizationMember,
  Customer, Invoice, Payment, ActivityEvent, BusinessEvent, OperatorInsight,
  ActionProposal, Communication, DeliveryAttempt
- **Auth**: Auth.js v5 (Credentials + JWT sessions), bcrypt password hashing
- **Money**: integer minor units as `BigInt` — never floating point; see
  [docs/accounts-receivable.md](./docs/accounts-receivable.md)
- **AI**: provider-agnostic Gateway (`AI_PROVIDER=none` by default, no
  credentials required to run the app); see
  [docs/ai-architecture.md](./docs/ai-architecture.md)
- **Email**: provider-agnostic Gateway over SMTP (`EMAIL_PROVIDER=none` by
  default, no credentials required to run the app or draft/preview
  reminders); see [docs/communications.md](./docs/communications.md)
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
- [docs/domain-model.md](./docs/domain-model.md) — core domain entities
- [docs/ai-architecture.md](./docs/ai-architecture.md) — AI provider abstraction
- [docs/provider-strategy.md](./docs/provider-strategy.md) — external provider boundaries
- [docs/exit-readiness.md](./docs/exit-readiness.md) — commercial/due-diligence tracking
