# Deployment

## Local development

Requirements: Node.js 22+, npm, and a local PostgreSQL — required from
Phase 1 onward (see `docs/identity-and-tenancy.md`). Docker is one way to
get Postgres, not a requirement; see below.

```bash
npm install
cp .env.example .env.local
```

Then fill in `.env.local`:

- `DATABASE_URL` — already defaults to the value matching
  `docker-compose.yml` below; change it if you're using a different local
  Postgres.
- `AUTH_SECRET` — required, no default on purpose (see SECURITY.md).
  Generate one: `openssl rand -base64 33`.

```bash
docker compose up -d postgres   # or point DATABASE_URL at any local Postgres 14+
npx prisma migrate dev
npm run dev
```

The app boots at http://localhost:3000.

### Local PostgreSQL

A `docker-compose.yml` at the repo root starts a local Postgres instance
with no external account or paid service:

```bash
docker compose up -d postgres
```

This exposes Postgres on `localhost:5432` with the credentials in
`docker-compose.yml` (development-only, not used anywhere else — matches
the `DATABASE_URL` default in `.env.example`).

If Docker isn't available, any locally installed Postgres 14+ works
identically — only the connection string changes.

### Test database

`npm run test` runs integration tests against a real Postgres database
that it truncates between tests — deliberately a separate database from
the one `npm run dev` uses, so running tests never touches your local dev
data:

```bash
createdb -h localhost -U paynora paynora_test   # or: docker compose exec postgres createdb -U paynora paynora_test
DATABASE_URL=postgresql://paynora:paynora@localhost:5432/paynora_test?schema=public npx prisma migrate deploy
npm run test
```

`vitest.config.mts` defaults `DATABASE_URL` for the test run to
`paynora_test` on `localhost:5432`; set `TEST_DATABASE_URL` to override.

## Collections automation scheduler

Collections automation (Phase 5, see `docs/collections-automation.md`) is
disabled by default in every environment, including local dev — running
`npm run dev` with no extra configuration behaves exactly as it did before
Phase 5 existed. To exercise it locally:

```bash
# in .env.local
AUTOMATION_ENABLED=true
AUTOMATION_CRON_SECRET=$(openssl rand -base64 24)
```

With that set, an OWNER can drive `runAutomationTick` from the
`/app/[orgSlug]/automation` page's dev-only manual trigger (never rendered
when `NODE_ENV=production`), or you can call the real scheduler endpoint
directly:

```bash
curl -X POST http://localhost:3000/internal/automation/tick \
  -H "Authorization: Bearer $AUTOMATION_CRON_SECRET"
```

For a real deployment, point any scheduler capable of an authenticated
HTTPS POST on an interval (Vercel Cron, a self-hosted `cron` + `curl`, a
systemd timer, a scheduled CI workflow — none of it is hardcoded into the
app) at that same endpoint with the same secret. See
`docs/collections-automation.md#scheduler-deployment` for the full
design and a reasonable interval.

## Integration & Provider Foundation (Phase 6)

Everything in this section is optional — the app boots and every existing
feature works with none of it set, exactly like `AI_PROVIDER`/
`EMAIL_PROVIDER` before it. See `docs/integration-architecture.md` for the
full design and status of each provider.

To exercise the real OpenRouter or Mistral AI adapter locally:

```bash
# in .env.local
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...          # e.g. a model slug from https://openrouter.ai/models
```

Both have free/low-cost tiers reachable without a foreign bank card at the
time of writing; see `docs/integration-architecture.md#ai-routing` for why
GigaChat/Yandex AI remain recognized-but-unimplemented instead. An
optional single fallback:

```bash
AI_PROVIDER_FALLBACK=mistral
MISTRAL_API_KEY=...
MISTRAL_MODEL=...
```

To exercise the real Telegram messaging adapter:

```bash
MESSAGING_PROVIDER=telegram
TELEGRAM_BOT_TOKEN=...        # from @BotFather
```

As of Phase 8, this is a real second communication channel (see
[Production Communications & AI (Phase 8)](#production-communications--ai-phase-8)
below) — a customer needs `telegramChatId` set (via the Customer edit
form or directly) before a reminder can actually be sent there.

`BILLING_PROVIDER` and `DEPLOYMENT_PROFILE` have no local-dev setup step
yet — `stripe`/`yookassa` are recognized but throw "not implemented" if
selected (see `docs/integration-architecture.md#billing`), and
`DEPLOYMENT_PROFILE` is descriptive-only metadata with no effect on
runtime behavior.

## Production Communications & AI (Phase 8)

Telegram now has a real domain caller (Email and Telegram are both
first-class communication channels — see `docs/communications.md#channel-model`),
and the AI/Email/Messaging gateways were hardened for production use (real
request cancellation on timeout, HTTP status classification, SMTP socket
timeouts). No new environment variables were introduced — everything
above (`AI_PROVIDER*`, `OPENROUTER_*`, `MISTRAL_*`, `EMAIL_PROVIDER`,
`SMTP_*`, `PAYNORA_EMAIL_FROM`, `MESSAGING_PROVIDER`, `TELEGRAM_BOT_TOKEN`)
is unchanged in shape; Telegram's variables simply now do something when
set.

One Prisma migration was added:
`prisma/migrations/20260812152618_phase8_communication_channels` — adds
`TELEGRAM` to the `CommunicationChannel` enum and two nullable columns to
`customers` (`telegramChatId`, `preferredCommunicationChannel`). Apply it
the same way as any other migration (`prisma migrate deploy` in
production, `prisma migrate dev` locally) — it has no data backfill step
and is safe against an existing `customers` table (both new columns are
nullable, no default required).

### Live smoke test (`npm run smoke`)

A dev-only, manual CLI for verifying a real configured provider actually
works against the real vendor — `scripts/live-smoke-test.ts`. It is
**never** invoked by `npm test`, CI, or any application code path; running
it requires you to type the command yourself, with `--confirm`:

```bash
npm run smoke -- ai openrouter --confirm      # real OpenRouter call
npm run smoke -- ai mistral --confirm         # real Mistral call
npm run smoke -- email --to=you@example.com --confirm     # real SMTP send
npm run smoke -- telegram --to=<chat-id> --confirm         # real Telegram send
```

Every target requires `--confirm` and (for email/telegram) an explicit
`--to` — there is no default recipient and nothing is ever sent
automatically. It refuses to run under `CI=true` or inside the Vitest
runner, and only ever logs a normalized provider name/result — never a
secret, a raw response body, or a request header.

## Production hosting model

Decided in Phase 9 (see `docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md`
P1-8) — a hard requirement for any production deployment, not a TODO.

**Runtime: a long-lived Node.js process, not an edge/serverless function
model.** This is not a preference — it's what the app's existing database
layer already assumes and requires:

- `src/server/db/client.ts` creates one `PrismaClient`/`pg.Pool` at module
  load and reuses it for the life of the process (a global singleton —
  the standard pattern for a persistent server). `DATABASE_POOL_MAX`
  (default 10, env-configurable) bounds *that one process's* pool size.
- A per-invocation serverless/edge model (Vercel Edge Functions, a bare
  AWS Lambda, Cloudflare Workers) would instead create a fresh pool on
  every cold start. At any real concurrency this exhausts Postgres's
  `max_connections` long before the app hits any other limit — the
  well-known "serverless + Postgres" problem, normally solved with an
  external pooler (PgBouncer, Prisma Accelerate, a provider's built-in
  HTTP/edge driver such as Neon's). This codebase includes none of that,
  and adding one speculatively — before a real deployment target requires
  it — is exactly the over-engineering the Phase 9 brief warns against.
  The chosen fix is simpler: don't run in that model.

**Deploy target:** `next build && next start` (or an equivalent container
running that build) on any host that can run a long-lived Node.js 22+
process with a reachable Postgres 14+ — a VPS, any container platform, or
self-hosted infrastructure. This satisfies the project brief's constraint
that the core workflow must not depend on a foreign-only service that may
be inaccessible from Russia (Vercel, alongside Stripe/OpenAI/Anthropic/
Clerk, is never a requirement). Vercel itself still works if chosen — this
app never opts into Vercel's Edge Runtime — but nothing here is
Vercel-specific.

**Database:** a single reachable Postgres 14+ instance (required since
Phase 1). No read replicas or multi-region setup — out of scope until a
real deployment's load actually requires it.

**Migrations:** run `npx prisma migrate deploy` once, before the new
process/container starts serving traffic (a deploy-time step — a CI/CD
pipeline stage, or container entrypoint ordering) — never `prisma migrate
dev` in production (that's the interactive, dev-only command used
elsewhere in this doc), and never triggered automatically by the running
app at request time, which could race a live request against an
in-progress schema change.

**Scheduler:** unchanged from
[Collections automation scheduler](#collections-automation-scheduler)
above — any external trigger capable of an authenticated HTTPS POST on an
interval, running independently of the app process (the app has no
built-in cron loop by design).

**Health/readiness:** `/internal/automation/health` (Phase 9, see
`docs/collections-automation.md`) is the automation-specific liveness/
readiness signal. There is no separate generic `/health` endpoint yet —
any successful response from the running app is today's baseline
liveness check. Noted here as an honest boundary, not a solved problem:
a real alerting/monitoring setup needs its own credentials and is outside
what this repository can commit to on its own.

**Explicitly not decided here, and not this codebase's concern:** TLS
termination/reverse proxy, container orchestration platform, secrets
manager, CDN. Standard "any competent hosting setup" concerns, left to
whoever operates the actual deployment.

## Backups & point-in-time recovery

Not implemented by this application, and not something application code
can substitute for — this is a hard requirement for whoever operates the
production database, documented here because SECURITY.md's "Organization
deletion" note points here, and because the audit found no backup story
was written down anywhere.

PAYNORA has no in-app soft-delete, undo, or recycle bin for any
tenant-scoped data (see SECURITY.md's organization-deletion cascade
note). The only real recovery path for accidental deletion, a bad
migration, or storage corruption is a database-level backup taken
independently of the app:

- Enable your Postgres host's continuous backup / point-in-time recovery
  (PITR) if it offers one (most managed Postgres providers do, as a
  configuration toggle, not a code change).
- If self-hosting Postgres directly, configure WAL archiving and
  periodic base backups (`pg_basebackup` + continuous WAL archiving, or
  `pg_dump` on a schedule as a lower-fidelity fallback) — standard
  Postgres operations, not specific to this app.
- Verify restores actually work before relying on them — an untested
  backup is not a backup.

This section intentionally stops at "here is what's required and why" —
which specific tool or managed-provider feature to use depends on the
hosting choice made under
[Production hosting model](#production-hosting-model) above, which this
repository doesn't dictate.

## Environment variables

See `.env.example` for the authoritative, current list. From Phase 1
onward, `DATABASE_URL` and `AUTH_SECRET` are required — both are free and
local, no paid or foreign-only service involved. `AUTOMATION_ENABLED`/
`AUTOMATION_CRON_SECRET` (Phase 5) are optional and default to fully
disabled — see [Collections automation scheduler](#collections-automation-scheduler).
`AI_PROVIDER_FALLBACK`/`OPENROUTER_*`/`MISTRAL_*`/`MESSAGING_PROVIDER`/
`TELEGRAM_BOT_TOKEN`/`BILLING_PROVIDER`/`DEPLOYMENT_PROFILE` (Phase 6) are
all optional and default to disabled/descriptive-only — see
[Integration & Provider Foundation](#integration--provider-foundation-phase-6).
