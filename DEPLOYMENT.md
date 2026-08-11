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

## Hosting (future)

No hosting target is committed to yet. The constraint that shapes the
choice, from the project brief: the core workflow must not depend on a
foreign-only service that may be inaccessible from Russia (this
specifically rules out treating Vercel as a requirement, alongside Stripe,
OpenAI, Anthropic, and Clerk). Next.js does not require Vercel to run — it
builds to a standard Node.js server (`npm run build && npm run start`) or a
container, so self-hosting or a Russia-accessible hosting provider are both
viable without any code changes. This decision is deferred to the phase
that actually needs a public deployment (Phase 8+), and will be documented
here when made — not before.

## Environment variables

See `.env.example` for the authoritative, current list. From Phase 1
onward, `DATABASE_URL` and `AUTH_SECRET` are required — both are free and
local, no paid or foreign-only service involved. `AUTOMATION_ENABLED`/
`AUTOMATION_CRON_SECRET` (Phase 5) are optional and default to fully
disabled — see [Collections automation scheduler](#collections-automation-scheduler).
