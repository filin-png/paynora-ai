# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — Phase 1: Identity & Multi-Tenancy

- Authentication via Auth.js v5 (Credentials provider, JWT sessions),
  bcrypt password hashing with timing-safe handling of unknown emails.
- `User`, `Organization`, `OrganizationMember` Prisma models and their
  first migration (`prisma/migrations/20260810183612_init_identity_and_tenancy`).
- Prisma driver adapter (`@prisma/adapter-pg`) — required by Prisma 7 for
  actual database connections, not just schema tooling.
- Transactional organization creation: creator becomes `OWNER` atomically,
  with a test proving no orphan organization survives a failed membership
  insert.
- Framework-agnostic authorization primitives (`requireUser`,
  `requireOrganizationMembership`, `requireOrganizationRole` in
  `src/server/tenancy/context.ts`) plus a thin Next.js redirect/404 layer
  (`src/server/tenancy/guards.ts`).
- Tenant context resolved from the URL slug and re-verified against
  database membership on every request — never trusted from a cookie or
  client-supplied value.
- Enumeration-safe error handling: nonexistent organization, existing
  organization you're not a member of, and wrong role all produce the same
  outcome (404 for pages).
- Minimal UI: `/sign-up`, `/sign-in`, protected `/app` shell, organization
  creation, and an organization page with member list and an OWNER-only
  rename form (the one role-gated operation this phase needed to exercise
  the model).
- 37 automated tests (Vitest against a real Postgres test database):
  password hashing, slug generation, registration/validation, organization
  creation and duplicate-membership rejection, and tenant isolation
  (member of Org A can't access Org B, unauthenticated access rejected,
  MEMBER rejected from the OWNER-only action).
- CI now runs a Postgres service container and applies migrations before
  running the test suite.
- New `docs/identity-and-tenancy.md`; README, ARCHITECTURE, SECURITY,
  DEPLOYMENT, and `docs/domain-model.md` updated to match.

### Added — Phase 0: Foundation

- Next.js (App Router) application with React 19 and TypeScript in strict mode.
- Tailwind CSS v4 and a shadcn/ui-compatible component convention
  (`src/components/ui`, `cn` helper, `components.json`), with a first
  `Button` component.
- Prisma toolchain configured for PostgreSQL (`prisma/schema.prisma`,
  `prisma.config.ts`); no domain models yet — introduced in Phase 1.
- Zod-based environment validation (`src/lib/env.ts`) with unit tests;
  nothing is required to boot the app in this phase.
- ESLint (Next.js core-web-vitals + TypeScript rules).
- Vitest test runner with a passing suite.
- GitHub Actions CI workflow running typecheck, lint, test, and build.
- Baseline documentation: README, ARCHITECTURE, ROADMAP, SECURITY,
  DEPLOYMENT, and `docs/` (domain model, AI architecture, provider
  strategy, exit readiness).
- Honest, minimal landing page describing the product mission — no fake or
  non-functional interactive elements.
