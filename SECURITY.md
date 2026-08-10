# Security

PAYNORA handles financial data (invoices, payments, customer collection
communication) for multiple tenants. Security is a baseline requirement,
not a later add-on.

## Principles

- **Validate at the boundary.** All external input — HTTP requests, AI
  provider output, environment variables — is validated with Zod before it
  reaches business logic. AI output is treated as untrusted external
  output, the same as user input.
- **Authorization is server-side, always.** The UI hiding a control is
  never treated as access control. Every query and mutation checks that
  the acting user is authorized for the organization the data belongs to.
- **Tenant isolation is a hard requirement.** Organization A must never be
  able to read or modify Organization B's data, under any code path.
  Automated tests cover this once multi-tenant data access exists
  (Phase 1).
- **Secrets never enter source control.** `.env*` files are gitignored
  except `.env.example`, which documents variable names only — no real
  values. See `.env.example` for the current (empty) list.
- **Prompt-injection awareness.** Customer email/message content fed into
  AI features is untrusted input. Before any AI feature consumes external
  communication (Phase 3+), its prompt construction is reviewed for
  injection risk and its output is schema-validated before use.
- **Idempotency for money-adjacent automation.** Background jobs and
  webhook handlers (Phase 4+) are designed to be safely retried — running a
  reminder job twice must not send a duplicate reminder.
- **No sensitive data in logs.** Structured logging (introduced when
  observability infrastructure is added) excludes credentials, tokens, and
  full customer payment details.

## Current status (Phase 1)

- **Passwords** are hashed with bcrypt (cost 12, `src/server/auth/password.ts`)
  and never stored or logged in plain text. Login compares against a
  precomputed dummy hash when no user is found, so a failed login takes
  the same time whether or not the email exists — timing-based account
  enumeration doesn't work.
- **Sessions** are Auth.js-managed JWTs, signed/encrypted with
  `AUTH_SECRET` (required, ≥32 characters, no default — `src/lib/env.ts`
  fails startup rather than falling back to something predictable). The
  session carries only `{ id, email, name }` — no role or organization
  claims, so a stale token can't grant stale authorization.
- **CSRF**: Auth.js's own sign-in/sign-out flow has built-in CSRF
  protection when invoked through its `signIn`/`signOut` functions (used
  here, not a hand-rolled fetch). PAYNORA's own Server Actions
  (`createOrganization`, `registerUser`, org rename) get Next.js's
  built-in Server Action CSRF protection (Origin/Host header validation)
  for free — neither is reimplemented.
- **Tenant isolation** is enforced in `src/server/tenancy/context.ts` on
  every organization-scoped request: membership is re-verified against the
  database by URL slug on every call, never trusted from a cookie or
  client-supplied value. Automated tests
  (`src/server/tenancy/context.test.ts`) run against a real database and
  cover cross-tenant access, unauthenticated access, and role checks — see
  `docs/identity-and-tenancy.md`.
- **Organization enumeration**: "no such organization", "organization
  exists but you're not a member", and "wrong role for this operation" all
  produce the identical outcome (`OrganizationAccessDeniedError`, a 404 on
  pages) — an attacker can't use response differences to discover which
  org slugs exist.
- **Unsafe redirects**: the sign-in flow's `callbackUrl` is validated to be
  a relative in-app path before use (both in the page and the Server
  Action) — an absolute URL is ignored in favor of `/app`, preventing an
  open-redirect via a crafted sign-in link.
- **Input validation**: registration and organization name/rename go
  through Zod schemas (`src/server/auth/users.ts`,
  `src/server/tenancy/organizations.ts`) before touching the database.
- No secrets are committed. `.env.example` documents variable names and,
  for `AUTH_SECRET`, deliberately ships no value.
- Dependencies are installed from the public npm registry with no known
  vulnerabilities at time of writing (`npm audit` reports 0 vulnerabilities
  as of the last dependency install).
- CI runs typecheck, lint, and the full test suite (including tenant
  isolation) against a real Postgres service container on every change.

## Reporting a vulnerability

This repository does not yet have a public release or paying customers.
Until a dedicated security contact is published here, report concerns by
opening a GitHub issue marked `security` with minimal public detail, or by
contacting the repository owner directly.
