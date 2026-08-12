# Architecture

## Shape: modular monolith

PAYNORA is a single Next.js application, not a collection of services. At
the target scale (small B2B service businesses, tens to low hundreds of
paying customers before any Phase 7 integration work), microservices would
add operational cost and founder dependency without a corresponding
benefit. The monolith stays maintainable by enforcing internal module
boundaries instead of process boundaries.

Boundaries are introduced when a phase actually needs them — not
speculatively.

## Current layout

```
src/
  app/                    Next.js App Router: routes, layouts, pages
    sign-in/, sign-up/     Public auth pages + their Server Actions
    app/                   Protected shell (requires auth) and org routes
      organizations/new/    Organization creation
      [orgSlug]/             Org-scoped nested layout (nav), no auth check itself
        page.tsx              AR dashboard (real data — see docs/accounts-receivable.md)
        settings/              Members list, OWNER-only rename
        customers/              List/create/detail/edit/archive
        invoices/                List/create/detail, record payment, cancel
        actions/                 Action Center: pending/decided proposals,
                                   manual "Run Operator" — see
                                   docs/operator-foundation.md
          [proposalId]/           Review/edit/send an email draft for one
                                   approved proposal — see docs/communications.md
        automation/              Collections automation: kill switch, policy
                                   list, active sequences — see
                                   docs/collections-automation.md
    api/auth/[...nextauth]/ Auth.js route handler
    internal/automation/tick/ Vendor-neutral scheduler adapter endpoint —
                             see docs/collections-automation.md#scheduler-deployment
  components/ui/          Reusable, shadcn/ui-style UI primitives (cva + cn)
  lib/                     Cross-cutting utilities (env validation, cn helper)
  server/
    auth/                  Auth.js config, password hashing, registration
    db/                    Prisma client singleton (+ test-only reset helper)
    tenancy/               Authorization primitives, org creation, slugs
    ar/                    Accounts-receivable domain/service layer — see
                             docs/accounts-receivable.md. Customer/Invoice/
                             Payment/ActivityEvent logic, money/currency/date
                             helpers, plus reminder-context.ts (deterministic
                             invoice/customer facts shared by Operator and
                             Communications). Pages and Server Actions call
                             this layer; it is the only place financial
                             calculations happen (never duplicated in a
                             component or trusted from the client).
    ai/                    Provider-agnostic AI Gateway — see
                             docs/ai-architecture.md. Nothing outside this
                             directory (and its two callers,
                             src/server/operator and
                             src/server/communications) knows a specific AI
                             vendor exists.
    operator/               Operator pipeline — see docs/operator-foundation.md.
                             Event detection, deterministic context, insight/
                             proposal creation, approval workflow. Reads AR
                             data through src/server/ar/*; never writes to it.
    email/                 Provider-agnostic Email Gateway — see
                             docs/communications.md#provider-abstraction.
                             SMTP adapter + test-only fake; nothing outside
                             this directory (and its only caller,
                             src/server/communications) knows a specific
                             transport exists.
    communications/         Draft/edit/send pipeline for email reminders —
                             see docs/communications.md. Reads AR + Operator
                             data (an approved ActionProposal, invoice/
                             customer facts); never writes to Invoice/
                             Payment/Customer; the only code path that calls
                             an EmailProvider.
    collections/             Collections automation — see
                             docs/collections-automation.md. Policy CRUD,
                             idempotent enrollment, the runAutomationTick
                             engine, and sequence pause/resume/stop. Drives
                             the existing Operator (src/server/operator) and
                             Communications (src/server/communications)
                             pipelines on a schedule; never a second
                             Operator or a second email sender.
    messaging/               Provider-agnostic Messaging Gateway (Phase 6) —
                             see docs/integration-architecture.md#messaging.
                             Telegram adapter + test-only fake; mirrors
                             src/server/email/ exactly. No domain call site
                             yet — a foundation, like AIProvider was at the
                             start of Phase 3.
    billing/                 BillingProvider types/contract only (Phase 6) —
                             see docs/integration-architecture.md#billing.
                             PAYNORA's own subscription billing, distinct
                             from AR/collections. No Prisma schema, no real
                             Stripe/YooKassa SDK call yet; Phase 7
                             "Monetization" work.
    providers/                Cross-cutting provider registry, deployment
                             profile, health model, and telemetry — see
                             docs/integration-architecture.md. Not owned by
                             any one category (ai/email/messaging/billing);
                             the one place that reports on all of them
                             together.
prisma/
  schema.prisma            User, Organization, OrganizationMember,
                             Customer, Invoice, Payment, ActivityEvent,
                             BusinessEvent, OperatorInsight, ActionProposal,
                             Communication, DeliveryAttempt, CollectionPolicy,
                             CollectionPolicyStep, CollectionSequence,
                             CollectionStepExecution
  migrations/               Applied migration history (includes hand-added
                             CHECK constraints — see docs/accounts-receivable.md)
prisma.config.ts            Prisma 7 config (schema path, datasource URL source)
```

`src/server/*` is server-only code (Prisma queries, password hashing,
session resolution) — nothing under it is imported by client components.
`src/server/tenancy/context.ts` is deliberately framework-agnostic (see
`docs/identity-and-tenancy.md`); `src/server/tenancy/guards.ts` is the thin
Next.js-specific layer (redirect/notFound) that pages and Server Actions
actually call. `src/server/ar/*` follows the same shape: functions take an
already-verified `organizationId`, never resolve auth themselves, and
every resource lookup is scoped to it (`where: { id, organizationId }`) —
a cross-tenant id fails exactly like a nonexistent one, the same
enumeration-safe pattern as `OrganizationAccessDeniedError`.

## Planned layout (introduced as each phase needs it)

`AIProvider` (below) is the first provider boundary actually implemented —
`src/server/ai/`, Phase 3. It sits behind `src/server/operator/`, layered
on top of the Phase 2 AR domain: an AI-generated insight summary
references an invoice's real computed state via a deterministically
built context object, it never duplicates or reinvents that state. Every
other provider boundary below remains unimplemented until the phase that
needs it — creating a directory before there is real code to put in it
would be dead scaffolding, which this project avoids on principle.

## Provider boundaries

Business/domain logic must never import a third-party SDK directly.
External capabilities are represented as interfaces owned by the
application; concrete implementations ("adapters") live behind them and are
selected via configuration. This is what makes the product portable away
from any one vendor, region, or founder's personal accounts — a direct
requirement for a sellable asset.

```
AIProvider (implemented, Phase 3;      generateStructured<T> — see src/server/ai/.
  extended Phase 6)                    OpenRouter/Mistral real adapters, bounded
                                        primary+fallback routing (Phase 6); GigaChat/
                                        Yandex AI recognized, not implemented.
EmailProvider (implemented, Phase 4)   send(message) over SMTP — see src/server/email/
MessagingProvider (implemented,        send(message) — see src/server/messaging/. Real
  Phase 6)                             Telegram adapter; no domain call site yet.
BillingProvider (types only, Phase 6)  verifyAndParseWebhook — see src/server/billing/.
                                        PAYNORA's own subscription billing (distinct from
                                        AR/collections). No schema, no real SDK yet —
                                        Phase 7 "Monetization" work.
AnalyticsProvider                     product analytics — not implemented
StorageProvider                       file/document storage — not implemented
AccountingProvider, CRMProvider,      documented only (docs/integration-architecture.md
  BankingProvider                     #documented-only-boundaries) — no TypeScript yet
JobProvider                           background job scheduling — Phase 5 needed a *trigger*
                                       boundary (POST /internal/automation/tick, vendor-neutral,
                                       auth via AUTOMATION_CRON_SECRET), not a job queue: the
                                       domain still doesn't know or care which scheduler calls
                                       it — see docs/collections-automation.md#scheduler-deployment
```

See `docs/ai-architecture.md` for the AI provider design,
`docs/provider-strategy.md` for the full provider list and the
Russia-accessibility constraint driving initial adapter choices, and
`docs/integration-architecture.md` for the Phase 6 cross-cutting provider
registry, deployment profiles, health model, and telemetry boundary that
apply across every category above.

## Multi-tenancy

All business data belongs to an `Organization` — as of Phase 5 that's
`Customer`, `Invoice`, `Payment`, `ActivityEvent` (Phase 2);
`BusinessEvent`, `OperatorInsight`, `ActionProposal` (Phase 3);
`Communication`, `DeliveryAttempt` (Phase 4); and `CollectionPolicy`,
`CollectionSequence`, `CollectionStepExecution` (Phase 5) — alongside
Phase 1's `OrganizationMember`. Authorization is enforced server-side on
every query and mutation via the primitives in
`src/server/tenancy/context.ts` — the UI hiding a control is never
sufficient. Tenant isolation has automated tests for the identity layer
(`src/server/tenancy/context.test.ts`), every Phase 2 resource
(`src/server/ar/*.test.ts`), every Phase 3 resource
(`src/server/operator/*.test.ts`), every Phase 4 resource
(`src/server/communications/*.test.ts`), and every Phase 5 resource
(`src/server/collections/*.test.ts`), all running against a real
database. Full design rationale: `docs/identity-and-tenancy.md`,
`docs/accounts-receivable.md`, `docs/operator-foundation.md`,
`docs/communications.md`, and `docs/collections-automation.md`.

## Validation strategy

External input is validated at the boundary with Zod before it reaches
business logic — environment variables (`src/lib/env.ts`), all Server
Action form input, and, since Phase 3, AI provider output
(`src/server/ai/gateway.ts`). AI output is treated as untrusted: it is
validated against a schema before being used, and a failure to produce
valid output degrades gracefully (falls back to a deterministic result)
rather than corrupting financial data or blocking the caller — see
`docs/ai-architecture.md`.

## TypeScript

`tsconfig.json` runs in `strict` mode. This is a Phase 0 baseline, not an
aspiration — CI fails the build if it regresses.
