# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
