# Deployment

## Local development

Requirements: Node.js 22+, npm. Docker is optional, only needed once you
want a real Postgres instance (Phase 1+).

```bash
npm install
cp .env.example .env.local
npm run dev
```

Nothing above requires a database or any external credential in Phase 0.

### Local PostgreSQL (needed from Phase 1 onward)

A `docker-compose.yml` at the repo root starts a local Postgres instance
with no external account or paid service:

```bash
docker compose up -d postgres
```

This exposes Postgres on `localhost:5432` with the credentials in
`docker-compose.yml` (development-only, not used anywhere else). Set:

```
DATABASE_URL=postgresql://paynora:paynora@localhost:5432/paynora?schema=public
```

in `.env.local`, then run `npm run db:generate` (and, once migrations
exist, `prisma migrate dev`).

If Docker isn't available, any locally installed Postgres 14+ works
identically — only the connection string changes.

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

See `.env.example` for the authoritative, current list. As of Phase 0,
every variable is optional and defaulted; nothing needs to be set to run
the app.
