# Architecture

## Shape: modular monolith

PAYNORA is a single Next.js application, not a collection of services. At
the target scale (small B2B service businesses, tens to low hundreds of
paying customers before any Phase 7 integration work), microservices would
add operational cost and founder dependency without a corresponding
benefit. The monolith stays maintainable by enforcing internal module
boundaries instead of process boundaries.

Boundaries are introduced when a phase actually needs them — not
speculatively. As of Phase 0, the only boundary that exists in code is
`src/lib/env.ts`, which validates `process.env` at the trust boundary
between the OS environment and the application.

## Current layout

```
src/
  app/                 Next.js App Router: routes, layouts, pages
  components/ui/       Reusable, shadcn/ui-style UI primitives (cva + cn)
  lib/                 Cross-cutting utilities (env validation, cn helper)
prisma/
  schema.prisma        Prisma schema (datasource + generator only, so far)
prisma.config.ts        Prisma 7 config (schema path, datasource URL source)
```

## Planned layout (introduced as each phase needs it)

Phase 1 (Identity & Multi-Tenancy) introduces:

```
src/server/auth/        Session/auth logic
src/server/tenancy/      Organization-scoped data access helpers
prisma/schema.prisma      User, Organization, OrganizationMembership models
```

Phase 2+ introduces domain modules per `docs/domain-model.md` (Customer,
Invoice, Payment, ...), and Phase 3+ introduces the provider boundaries
described below. Nothing under `src/core` or `src/server/providers` exists
yet — creating those directories before there is real code to put in them
would be dead scaffolding, which this project avoids on principle (see
Engineering Rules in the project brief).

## Provider boundaries (design, not yet implemented)

Business/domain logic must never import a third-party SDK directly.
External capabilities are represented as interfaces owned by the
application; concrete implementations ("adapters") live behind them and are
selected via configuration. This is what makes the product portable away
from any one vendor, region, or founder's personal accounts — a direct
requirement for a sellable asset.

```
AIProvider          generateReminder / classifyReply /
                     extractPaymentPromise / summarizeCustomerHistory
EmailProvider        send transactional/collection email
PaymentProvider       (billing, introduced Phase 6 — not accounting sync)
AnalyticsProvider      product analytics
StorageProvider        file/document storage
JobProvider            background job scheduling
```

See `docs/ai-architecture.md` for the AI provider design and
`docs/provider-strategy.md` for the full provider list and the
Russia-accessibility constraint driving initial adapter choices.

## Multi-tenancy (design, implemented starting Phase 1)

All business data belongs to an `Organization`. Authorization is enforced
server-side on every query and mutation — the UI hiding a control is never
sufficient. Tenant isolation is a security requirement with automated tests
attached, not an incidental property of the schema. Details land in
`docs/domain-model.md` as Phase 1 implements them.

## Validation strategy

External input is validated at the boundary with Zod before it reaches
business logic — this includes environment variables today
(`src/lib/env.ts`) and will include API request bodies and AI provider
output once those exist. AI output in particular is treated as untrusted:
it is validated against a schema before being used, and a failure to
produce valid output degrades gracefully rather than corrupting financial
data.

## TypeScript

`tsconfig.json` runs in `strict` mode. This is a Phase 0 baseline, not an
aspiration — CI fails the build if it regresses.
