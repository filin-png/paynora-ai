# PAYNORA AI

PAYNORA AI is a vertical SaaS for small B2B service businesses (2–30
employees) that helps them track accounts receivable, spot payment risk
early, and automate collection follow-up — without replacing the accounting
software they already use.

**Project status: Phase 0 — Foundation.** No product features are
implemented yet. This repository currently contains the technical
foundation the product will be built on: a booting Next.js application,
strict TypeScript, the UI/testing/CI toolchain, and baseline documentation.
See [ROADMAP.md](./ROADMAP.md) for what's next.

## Tech stack

- **Frontend/Backend**: Next.js (App Router), React, TypeScript (strict mode)
- **UI**: Tailwind CSS, shadcn/ui-compatible component architecture
- **Database**: PostgreSQL via Prisma (schema foundation only — no domain
  models yet)
- **Validation**: Zod
- **Testing**: Vitest
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

Requirements: Node.js 22+, npm.

```bash
npm install
cp .env.example .env.local   # optional in Phase 0 — nothing is required yet
npm run dev
```

The app boots at http://localhost:3000 with no environment variables and no
running database. A PostgreSQL database is only needed starting in Phase 1,
once domain models exist — see [DEPLOYMENT.md](./DEPLOYMENT.md) for local
Postgres setup.

## Scripts

| Script                | Purpose                                   |
| ---------------------- | ------------------------------------------ |
| `npm run dev`          | Start the Next.js dev server               |
| `npm run build`        | Production build                           |
| `npm run start`        | Run the production build                   |
| `npm run lint`         | ESLint (Next.js + TypeScript rules)        |
| `npm run typecheck`    | `tsc --noEmit`, strict mode                |
| `npm run test`         | Run the Vitest suite once                  |
| `npm run test:watch`   | Run Vitest in watch mode                   |
| `npm run db:validate`  | Validate `prisma/schema.prisma`            |
| `npm run db:generate`  | Generate the Prisma client                 |

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system structure and boundaries
- [ROADMAP.md](./ROADMAP.md) — phased build plan and current status
- [CHANGELOG.md](./CHANGELOG.md) — what actually shipped, by date
- [SECURITY.md](./SECURITY.md) — security baseline and reporting
- [DEPLOYMENT.md](./DEPLOYMENT.md) — local and future deployment setup
- [docs/domain-model.md](./docs/domain-model.md) — core domain entities (planned)
- [docs/ai-architecture.md](./docs/ai-architecture.md) — AI provider abstraction
- [docs/provider-strategy.md](./docs/provider-strategy.md) — external provider boundaries
- [docs/exit-readiness.md](./docs/exit-readiness.md) — commercial/due-diligence tracking
