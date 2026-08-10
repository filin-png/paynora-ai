# Identity & Multi-Tenancy (Phase 1)

This document describes what Phase 1 actually implemented: authentication,
the User/Organization/OrganizationMember schema, roles, tenant context, and
the authorization primitives that enforce isolation between organizations.

## Authentication

**Approach:** Auth.js v5 (`next-auth@beta`) with a Credentials provider and
JWT sessions. No OAuth providers, no database session storage, no
`@auth/prisma-adapter` — none of those are needed for email/password login,
and adding them would be unused surface area.

**Why Auth.js instead of hand-rolled sessions:** the project brief is
explicit that Phase 1 should not invent a custom cryptographic auth
protocol and should prefer an established library. Auth.js owns session
cookie signing/encryption, CSRF protection for its sign-in flow, and secret
handling; PAYNORA only supplies the `authorize()` callback that checks a
password against the database.

**Why Credentials, not an OAuth provider:** the brief requires the project
to remain developable from Russia without a foreign paid/inaccessible
service, and explicitly says not to add OAuth providers this phase. Email +
password has no such dependency.

**Why JWT sessions, not database sessions:** Auth.js's Credentials provider
only supports JWT sessions (database sessions require an adapter designed
around OAuth account linking, which doesn't apply here). The session JWT
carries only `{ id, email, name }` — no organization or role claims. Every
tenant-scoped request re-verifies membership and role against the database
(see "Tenant context" below); nothing about authorization is trusted from
the cookie. This was a deliberate choice, not an oversight: embedding a
role in the token would mean a stale token outlives a role change until it
expires.

**Password hashing:** bcryptjs, cost factor 12. bcryptjs is a pure-JS
implementation with no native build step, so it installs identically
everywhere — consistent with the project's portability goal (see
`docs/provider-strategy.md`). Argon2id is the current OWASP first choice,
but its common Node bindings are native modules; bcrypt remains
OWASP-acceptable and avoids that installation risk. `src/server/auth/password.ts`
also compares against a precomputed dummy hash when no user is found for a
login attempt, so "unknown email" and "wrong password" take the same time
— this prevents timing-based account enumeration.

**Registration:** `/sign-up` calls `registerUser()`
(`src/server/auth/users.ts`), which normalizes the email (trim + lowercase),
rejects a duplicate (including a database-level race between the
existence check and the insert — see the code comment), hashes the
password, and creates the `User` row. Login failures always return the
same generic "Invalid email or password" message, regardless of whether
the email exists — registration's duplicate-email error is more specific,
which is standard, accepted signup UX and not the account-enumeration
vector login is.

**Secret:** `AUTH_SECRET` is required (`src/lib/env.ts`, minimum 32
characters) with no default — a missing or too-short secret fails app
startup immediately rather than silently signing sessions with something
predictable. Generate one locally with `openssl rand -base64 33`; see
`.env.example`.

## Schema

`prisma/schema.prisma` (migration `20260810183612_init_identity_and_tenancy`):

- **User** — `id`, `email` (unique), `passwordHash`, `name?`, timestamps.
- **Organization** — `id`, `name`, `slug` (unique), timestamps. The tenant
  boundary.
- **OrganizationMember** — `id`, `userId`, `organizationId`, `role`
  (`OWNER` | `MEMBER`), timestamps. `@@unique([userId, organizationId])`
  makes a duplicate membership a database-level constraint violation, not
  just an application check. Foreign keys cascade on delete: removing a
  user or organization removes its membership join rows (not the other
  entity), which is safe because a membership row carries no data of its
  own worth preserving.

Deliberately **not** built this phase: `Account`/`Session`/`VerificationToken`
tables (unnecessary without OAuth/database sessions — see above), more than
two roles, or anything from `docs/domain-model.md` beyond User/Organization/
OrganizationMember.

## Tenant context

Every tenant-scoped route is addressed by **organization slug in the URL**
(`/app/[orgSlug]`), not by a value stored in a cookie or session. This is a
deliberate design choice: the slug in the URL is exactly the kind of
client-supplied value the brief warns against trusting, so making it the
*only* way to name "which organization" forces every single tenant-scoped
code path to re-verify membership — there is no implicit "current
organization" state that a bug could forget to check.

`requireOrganizationMembership(user, orgSlug)`
(`src/server/tenancy/context.ts`) does the verification: look up the
organization by slug, then look up a membership row for
`(user.id, organization.id)`. If either lookup misses, it throws
`OrganizationAccessDeniedError` — deliberately the same error for "no such
organization" and "organization exists but you're not a member of it", so
an authenticated attacker can't use the response to enumerate which org
slugs exist (`src/server/tenancy/errors.ts` has the full reasoning).

## Authorization primitives

`src/server/tenancy/context.ts` is framework-agnostic on purpose: its
functions take an already-resolved `SessionUser | null` rather than
reading cookies themselves, so they run identically in a Vitest test
against a real database and in a Next.js request — see
`src/server/tenancy/context.test.ts`, which is the tenant-isolation test
suite. `src/server/tenancy/guards.ts` is a thin Next.js-specific adapter
used by pages and Server Actions: it resolves the session, then translates
`UnauthenticatedError` into `redirect("/sign-in")` and
`OrganizationAccessDeniedError` into `notFound()` (a 404).

| Primitive (context.ts) | Page/action wrapper (guards.ts) | Behavior |
| --- | --- | --- |
| `requireUser(user)` | `requireUserForPage()` | Throws/redirects if unauthenticated |
| `requireOrganizationMembership(user, slug)` | `requireOrganizationMembershipForPage(slug)` | + verifies membership, 404s otherwise |
| `requireOrganizationRole(user, slug, role)` | `requireOrganizationRoleForPage(slug, role)` | + verifies role, 404s otherwise |

Every page and Server Action under `/app/*` calls one of the `*ForPage`
wrappers before touching any organization data — see `src/app/app/layout.tsx`
(authentication only) and `src/app/app/[orgSlug]/**` (membership and, for
the rename action, `OWNER` role).

## Organization creation

`createOrganization()` (`src/server/tenancy/organizations.ts`) creates the
`Organization` row and the creator's `OWNER` `OrganizationMember` row inside
one `prisma.$transaction`. If the membership insert fails for any reason,
Postgres rolls back the organization insert too — there is no code path
that leaves an organization without an owner.
`src/server/tenancy/organizations.test.ts` verifies this directly by
forcing the membership insert to fail (a foreign key violation from a
nonexistent user id) and asserting the organization row was never
persisted.

Slugs are generated from the organization name
(`src/server/tenancy/slug.ts`): lowercase, hyphenated, truncated, with a
short random suffix appended on collision. The slug is an internal
identifier, not something the organization "picks" — collisions ("Acme",
"Acme Inc") are expected and handled rather than rejected.

## What a MEMBER can't do

Phase 1's one OWNER-only operation is renaming the organization
(`src/app/app/[orgSlug]/actions.ts`, `renameOrganizationAction`) — a
minimal, real example of role-gated behavior, not a feature invented to
have something to test. Both the page (which conditionally renders the
rename form) and the Server Action independently call
`requireOrganizationRoleForPage(orgSlug, "OWNER")` — the UI hiding the form
is a convenience, not the enforcement; a MEMBER who submits the action
directly still gets a 404.

## Testing

`src/server/tenancy/context.test.ts` and `organizations.test.ts` run
against a real Postgres database (not mocks) — see the "Local
development" section below. They cover the required categories from the
Phase 1 acceptance criteria: a member of Organization A can access
Organization A; a member of Organization A cannot access Organization B;
unauthenticated access fails; MEMBER is rejected from the OWNER-only
rename; duplicate memberships are rejected at the database level, not just
in application code. `src/server/auth/users.test.ts` covers registration
and validation (duplicate/invalid email, short password, password never
stored in plain text). `src/server/auth/password.test.ts` and
`src/server/tenancy/slug.test.ts` cover the pure, DB-free units.

## Local development

Beyond Phase 0's setup, Phase 1 needs:

1. A running local Postgres (`docker compose up -d postgres`, or any local
   instance — see DEPLOYMENT.md) and `DATABASE_URL` set.
2. `AUTH_SECRET` set (`openssl rand -base64 33`).
3. `npx prisma migrate dev` to create the schema.
4. A second database for tests (`createdb paynora_test`) — see
   `vitest.config.mts` and `.env.example`'s `TEST_DATABASE_URL`.

None of this requires a paid or foreign-only service.
