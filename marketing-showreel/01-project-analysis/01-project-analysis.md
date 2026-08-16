# Stage 1 — Project Analysis

Based on direct source-code inspection (not README/marketing text) of both repositories. Every claim below is traceable to actual files.

---

## PAYNORA AI

**What it does:** A B2B accounts-receivable / invoice-collections SaaS. Users create an organization, add customers and invoices, record payments, and can turn on an automated "Operator" that watches due dates, drafts AI-assisted payment-reminder messages, and sends them by email/Telegram on a schedule — with a human-approval gate and org-level kill switches before anything goes out.

**Tech stack (verified):** Next.js 16.3 (App Router) + React 19.2, TypeScript, Tailwind CSS 4, Prisma 7 over PostgreSQL 16, Auth.js (NextAuth v5) with Credentials + bcrypt, Zod validation, Vitest. Plain Server Actions / Route Handlers — no GraphQL/tRPC. Dockerized local Postgres.

**Architecture:** Layered `app → server/<domain> → Prisma/Postgres`. True multi-tenancy: every query scoped by `organizationId`. A documented event pipeline drives automation: `BusinessEvent → OperatorInsight → ActionProposal → Communication → DeliveryAttempt`, explicitly designed so the AI never writes directly to the database. A provider-abstraction pattern repeats consistently across AI / Email / Messaging / Billing, each with a safe "none"/"fake" implementation plus real adapters.

**Auth & security:** Session-based Credentials auth, enumeration-safe login, constant-time secret comparison, IP+account rate limiting on sign-in/sign-up (explicit "P0" hardening commit). Org-scoped RBAC (`OWNER`/`MEMBER`).

**Database & financial correctness:** 18-model schema across 9 dated migrations reflecting a real phased build. Money is stored as integer minor units, never floats. Row-level locking (`SELECT ... FOR UPDATE`) prevents invoice cancel/payment races. A dispatch-finalization race was found and fixed with a compare-and-swap, backed by a regression test that reproduces the race. Client-generated idempotency keys on payment recording. Cross-org pagination-cursor leakage was tested and closed.

**AI — real, not decorative:** Actual HTTP integrations to OpenRouter and Mistral (OpenAI-compatible chat completions), used to draft reminder messages, with a documented 2-provider fallback chain, deterministic non-AI validation of AI output, and a safety-guard layer. Unconfigured (`AI_PROVIDER=none` by default) the app still runs fully — AI degrades gracefully, it isn't required.

**Automation:** A bearer-secret-protected internal tick endpoint runs bounded, cursor-rotated batches so no organization starves. Two independent kill switches (deployment-level and per-org) gate anything from sending automatically.

**Integrations wired and working:** SMTP email (nodemailer), Telegram Bot API (real `sendMessage` calls, token never logged), OpenRouter/Mistral AI. Stripe/YooKassa billing and GigaChat/Yandex AI are recognized but explicitly throw a typed "not implemented" error rather than faking success — an honest incompleteness, not a hidden one.

**Testing & CI:** 52 test files, ~21k LOC of `src`, run against a real Postgres instance in CI (not mocks). Includes genuine concurrency/race regression tests, not just happy-path checks. GitHub Actions runs typecheck, lint, `prisma validate`, migrate, test, build on every push.

**Engineering rigor (from git history):** A visible "Phase 9 production hardening" pass, and multiple commits explicitly framed as adversarial pre-merge self-review that found and closed real races before merge — unusual discipline for a solo/portfolio project.

**Honest gaps:** No seed/demo data script (a fresh instance starts empty); Stripe/YooKassa and GigaChat/Yandex are stubs; single auth method (no OAuth); no CD automation beyond CI tests.

---

## NEXORA AI

**What it does:** An AI-powered financial-analysis platform shipped as three coordinated codebases: a Next.js web app, a standalone Fastify backend, and an Expo/React Native mobile app. Users get an AI advisor chat, business/asset analysis, market-intelligence comparisons, manual portfolio tracking, and multi-section AI-generated investment reports, with subscription billing (Stripe on web, RevenueCat on mobile) and RU/EN/CN/JP localization.

**Tech stack (verified):** Web — Next.js 16.2, React 19.2, TypeScript, Tailwind 4, Supabase (`@supabase/ssr`), Stripe, Framer Motion. Backend — an independent Fastify 5 service with its own JWT/JWKS auth (`jose`), Google Gemini (`@google/genai`), rate limiting, WebSockets. Mobile — Expo 57 / React Native 0.86, Zustand, TanStack Query, MMKV, RevenueCat.

**Architecture:** Three genuinely separate services, not one tangled app: ~30 Next.js route handlers for the website; a versioned (`/v1/...`) Fastify API purpose-built for the mobile client; an Expo Router mobile app with its own state layer. Root middleware (`proxy.ts`) applies security headers, per-path rate limiting, and session verification uniformly across the website.

**Auth & security:** Supabase Auth end-to-end, and — notably — the code consistently calls the token-revalidating `getUser()` rather than the cheaper-but-spoofable `getSession()`, enforced in middleware and mirrored in the mobile client. Row Level Security is enabled on every database table. Admin access is a signed-in-plus-UUID-allowlist check — simple, but real and consistently applied.

**AI — real, multi-provider:** Genuine provider abstraction (OpenRouter, Mistral, Google Gemini) with runtime provider switching, per-request context capping, safety-policy injection, automatic degrade-to-mock on provider failure (logged, not silent), and a per-request cost-estimation log. Each AI module (advisor, business analysis, market intelligence, localization, investment reports) has its own prompt file and input validation.

**Integrations wired and working:** Stripe (web billing), RevenueCat (mobile billing, with its own test suite), pluggable market-data providers (Finnhub/Alpha Vantage/CoinGecko/Twelve Data) with a labeled mock fallback. No Telegram, email provider, or SMS integration exists in this codebase.

**Testing & CI:** The backend has a real test suite (12 files, ~850 lines) covering auth, AI degrade paths, billing, webhooks, rate limiting. The main website codebase has zero tests — CI only typechecks/lints/builds it. Three parallel CI jobs (web/backend/mobile) on GitHub Actions.

**Self-documentation is unusually honest for a resale-oriented codebase:** `SALE.md` and `docs/DEMO_AND_REALITY_GUIDE.md` explicitly enumerate what's real vs. mock — e.g. the mobile "Wallet"/"Send" screens are clearly labeled non-functional crypto UI, and a "voice AI" feature is documented as design-only with zero code behind it.

**Honest gaps:** No tests for the website; rate limiting is in-memory only (won't survive multi-instance deploy, acknowledged in project docs); admin authorization is an env-var allowlist, not a roles system; no automation/bots beyond payment webhooks; some UI surfaces exist ahead of their backing logic.

---

## What these two projects demonstrate about the developer

Read together, not individually, these projects show:

1. **Real full-stack range** — Next.js/React/TypeScript on the front end, Postgres/Prisma and a separate Fastify service on the back end, plus a native mobile app (Expo/React Native) — three different runtime environments built and kept consistent.
2. **Actual AI integration engineering**, not prompt demos — multi-provider abstraction, fallback chains, cost logging, safety validation, and graceful degradation to a documented mock when no key is present. This is the same pattern independently in both codebases, suggesting a repeatable practice, not a one-off.
3. **Production-grade financial/data correctness discipline** — row locking, compare-and-swap dispatch, idempotency keys, RLS on every table, enumeration-safe auth, rate limiting — the kind of work that only shows up when someone is thinking about what breaks under concurrency and abuse, not just the happy path.
4. **Honesty about scope** — both projects clearly separate what's implemented from what's stubbed (typed "not implemented" errors, `SALE.md`/`DEMO_AND_REALITY_GUIDE.md`), which is a credibility signal in itself: nothing here is faked to look more finished than it is.
5. **Working CI and real regression tests** for the more mature of the two projects (Paynora), including concurrency-race tests that most portfolio projects never attempt.

## Professional positioning (evidence-based, no invented history)

> A Full-Stack / AI developer who ships complete products end-to-end: Next.js/React/TypeScript front ends, PostgreSQL-backed multi-tenant back ends, and — when the product calls for it — a dedicated API service and native mobile app alongside the web app. Comfortable wiring real LLM providers into a product with fallback and safety handling, not just a chat widget. Applies real engineering discipline to the parts that matter most in financial and SaaS products — concurrency correctness, security, automated testing, CI — and is candid about what's built versus what's roadmap.

No claims of years of experience, seniority, or employment history are made or implied — this positioning is built entirely from what the two codebases demonstrate.
