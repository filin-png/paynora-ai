# Production Readiness (Phase 23)

Phase 23 is an architecture-and-hardening pass, not a deployment. Nothing
in this phase connects a real production credential, buys a domain,
creates a production database, or deploys anywhere — see each section's
own "what's still needed" line for exactly what a human has to do before
the next phase can actually go live.

This document is the launch checklist the phase brief asked for. It does
not re-explain systems that already have their own documentation — it
tells you the current state, links to where the detail lives, and says
plainly which of four states applies:

- **READY** — works today, in this codebase, with no further action.
- **READY AFTER CONFIG** — the code path is real and tested; a human
  needs to set real credentials/infrastructure before it does anything
  in production.
- **BLOCKED** — a real architectural or business decision must be made
  first; setting credentials alone would not make this safe or correct.
- **NOT IMPLEMENTED** — recognized but not built (by design, in most
  cases — see the linked doc for why).

If you take one thing from this document before reading further: **the
"Vercel" item (#14) is BLOCKED, not READY AFTER CONFIG** — this codebase's
existing, deliberate database-connection architecture (Phase 9) is
genuinely incompatible with a default Vercel serverless-function
deployment. See that section before assuming Vercel is a drop-in target.

## 1. Architecture — READY

No changes in this phase touched: tenant isolation
(`docs/identity-and-tenancy.md`), the AR domain, the AI Gateway/Provider
contract (`docs/ai-architecture.md`), the WalletProvider boundary
(`docs/wallet-architecture.md`), the BillingProvider boundary
(`docs/billing-provider.md`), or entitlements/subscriptions
(`docs/commercial-product-architecture.md`). The audit in this phase
confirmed these are already sound; see "Security findings" in the final
report for the two real, narrow gaps this phase actually closed (a
secret-shaped URL in the Alchemy adapter's error path, and untested env
cross-validation branches) — nothing else needed changing.

**Runtime model** (unchanged, Phase 9 decision, see
`DEPLOYMENT.md#production-hosting-model`): a long-lived Node.js process
(`next start`), not a per-invocation serverless function. This is the
single fact every other "is X ready" answer below depends on — see #14.

## 2. Environment variables — READY

`src/lib/env.ts` is the single source of truth: one Zod schema, defaults
that keep every feature off until explicitly configured, and
cross-field validation that requires a provider's real credentials only
once that provider is actually selected (never proactively). Phase 23
added test coverage for three validation branches that existed but were
untested (`WALLET_PROVIDER=alchemy`, `ANALYTICS_PROVIDER=posthog`,
`WEB_SEARCH_PROVIDER=anthropic` — see `src/lib/env.test.ts`); the schema
itself did not need to change.

There is no separate "client-safe config" module because there is
nothing to put in one: `grep -rn "NEXT_PUBLIC_"` across `src/` and
`.env.example` returns zero results, and no Client Component imports
`@/lib/env` (verified directly, not assumed). Every credential this app
uses is read server-side only, and stays that way structurally — a
Server Component or Server Action is the only place `env` is ever
imported from.

(An `import "server-only"` guard on `env.ts` was tried during this
phase's audit and reverted — it makes the module throw under plain
`tsx` execution, which breaks `npm run smoke` and
`npm run report:subscriptions`, both legitimate CLI scripts that
transitively import server modules. The actual leak risk was already
low — see the paragraph above — so this was not worth breaking two
working scripts.)

`.env.example` was audited line-by-line: every secret-shaped key is
present but empty (or commented out) with a real explanation of where to
get a production value, never a placeholder that looks real. This is now
enforced by `npm run production:check` (#17), not just discipline.

**What's still needed:** nothing, to keep every feature off. Turning any
integration on needs that integration's own real credential — see the
section below for each.

## 3. Secrets — READY

`AUTH_SECRET`, `DATABASE_URL`, and every provider API key/webhook secret
are read once at process start (`src/lib/env.ts`), never logged (see
`src/server/providers/telemetry.ts`'s fixed, secret-free event shape —
unchanged), and never returned in an HTTP response. Phase 23 found and
closed two real gaps of the same shape: both
`src/server/wallet/providers/alchemy.ts` and
`src/server/messaging/providers/telegram.ts` build their real vendor
request URL with the secret embedded directly in the path (Alchemy's API
key, Telegram's bot token — each vendor's own API design; every other
adapter in this codebase authenticates via an `Authorization` header
instead, where a raw fetch failure can't echo the secret back). Neither
adapter's HTTP-error-status path ever included the URL, but neither
wrapped the raw `fetch()` call itself — so a network-level failure (DNS/
connection error) propagated unmodified. Both now normalize every
failure, HTTP-status or network-level alike, into a message that never
contains the URL — see the new regression tests in `alchemy.test.ts` and
`telegram.test.ts`.

**What's still needed:** nothing architecturally. A real deployment
needs its own secret storage (a platform's env var UI, a secrets
manager) — out of this codebase's control by design, same as every prior
phase's position.

## 4. Database — READY AFTER CONFIG

Prisma schema, indexes, and constraints were spot-checked (unique
constraints on every provider-event-id pair, tenant-scoped composite
indexes, `RateLimitCounter`'s `(scope, key, windowStart)` uniqueness) and
found consistent with the careful, deliberate style every prior phase
already established — no schema change was made this phase; none was
needed. See #7 in the final report for the specific models checked.

**What's still needed:** a real, reachable Postgres 14+ instance and
`DATABASE_URL`, then `npx prisma migrate deploy` once before the new
process starts serving traffic. See `DEPLOYMENT.md#backups--point-in-time-recovery`
(already written) for backup/restore guidance and #14 below for why the
*hosting model* around that database is the real open question, not the
database itself.

**Vercel + Neon specifically** (the decided target for the Vercel
deployment phase): `DATABASE_URL` must be Neon's *pooled* connection
string (hostname contains `-pooler`), and `DIRECT_URL` (new — see
`.env.example` and `prisma.config.ts`) must be Neon's *direct* connection
string, used only by `prisma migrate deploy`/the Prisma CLI. Set
`DATABASE_POOL_MAX=1` (or similarly low) for this deployment. No code
changes beyond `prisma.config.ts` reading `DIRECT_URL` were needed — see
#14 for the full reasoning behind this being sufficient.

## 5. Authentication — READY

Auth.js v5, JWT sessions, credentials provider, `authenticateCredentials`
enforcing account+IP rate limits (`docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md`
P0-1) before ever touching the password hash. `AUTH_SECRET` is required,
minimum 32 characters, no fallback (`src/lib/env.ts`). Session/cookie
configuration is Auth.js's own default (`secure`/`httpOnly`/`sameSite`
all follow the library's documented production behavior — this app sets
no cookie config of its own, so there is nothing here that could
silently drift out of sync with a NextAuth upgrade). No OAuth providers
exist, so there is no callback-URL/redirect surface to harden beyond
what Auth.js already validates.

**What's still needed:** on a real deployment behind a proxy (Vercel or
otherwise), set `AUTH_URL` (or confirm the platform sets the trust-host
signal Auth.js v5 checks automatically — it does on Vercel) to the real
public origin, so cookies and callback construction resolve correctly.
Nothing to build — a config step at deploy time.

## 6. Billing — READY AFTER CONFIG

YooKassa adapter (Phase 20) already verifies webhook authenticity by
source-IP allowlist, resolves the organization from a
`BillingCheckoutSession` row PAYNORA itself created (never from anything
the webhook body claims), verifies amount+currency against that same row
before granting a plan, and is idempotent on `(provider, eventId)` via a
unique constraint — not a check-then-insert race. See
`docs/billing-provider.md` and `src/server/billing/webhook-events.ts`'s
own doc comment for the full design; this phase's audit found nothing
here that needed changing.

**What's still needed:** `BILLING_PROVIDER=yookassa`,
`YUKASSA_SHOP_ID`/`YUKASSA_SECRET_KEY` from a real YooKassa merchant
account, and the real deployment's public webhook URL registered with
YooKassa. No code change — pure configuration, next phase's job.

## 7. AI — READY AFTER CONFIG

Mistral is PAYNORA's primary provider (Phase 21A) — Gateway, quota,
rate-limit, telemetry, and prompt-injection defenses all already
verified in that phase's own audit (`docs/ai-integration.md`); nothing
in Phase 23 changed here.

**What's still needed:** `AI_PROVIDER=mistral`,
`MISTRAL_API_KEY`/`MISTRAL_MODEL` from a real Mistral account, then a
manual `npm run smoke -- ai mistral --confirm` before trusting it in
production (never run automatically — see #17).

## 8. Email — READY AFTER CONFIG

SMTP adapter (Phase 4/8), sender address fixed at the deployment level
(`PAYNORA_EMAIL_FROM`, never per-message user input — see
`docs/communications.md#sender-safety`). No code change this phase.

**What's still needed:** `EMAIL_PROVIDER=smtp` plus real
`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD` from a real relay,
then `npm run smoke -- email --to=you@example.com --confirm`.

## 9. Telegram — READY AFTER CONFIG

Adapter exists (`src/server/messaging/providers/telegram.ts`). See #3
above — this phase closed the same URL-embeds-the-secret gap here as in
the Alchemy adapter.

**What's still needed:** `MESSAGING_PROVIDER=telegram`,
`TELEGRAM_BOT_TOKEN` from @BotFather, then
`npm run smoke -- telegram --to=<chat-id> --confirm`.

## 10. Wallet — READY AFTER CONFIG

Alchemy adapter (Phase 14), non-custodial (Alchemy never holds a private
key), webhook signature verified with `timingSafeEqual` (constant-time
comparison — already correct), transaction ingestion idempotent on
`(network, txHash)`. Phase 23's one real fix here: see #3 above (API-key
URL leak in error paths, now closed and regression-tested).

**What's still needed:** `WALLET_PROVIDER=alchemy` and all four Alchemy
credentials from a real account (`docs/production-integrations.md#wallet`
has the exact setup steps), plus a domain to point the Alchemy-managed
webhook at (see #13) — wallet webhooks need a real public HTTPS URL to
register, unlike billing's outbound-initiated checkout flow.

## 11. Web Search — READY AFTER CONFIG

Anthropic's own `web_search` tool, delegated server-side — this codebase
never fetches an arbitrary URL itself for search (see "Security findings"
#5 in the final report); there is no SSRF surface to hardened because
there is no arbitrary-URL-fetching code path to begin with. No code
change needed.

**What's still needed:** `WEB_SEARCH_PROVIDER=anthropic`,
`ANTHROPIC_API_KEY` (a separate Anthropic account from any `AI_PROVIDER`
key), then `npm run smoke -- websearch --confirm`.

## 12. Analytics — READY AFTER CONFIG

PostHog adapter is server-side only — it posts to PostHog's HTTP capture
API from the server; no client-side script or pixel is ever loaded in
the browser (verified directly — see #9 below, this is also why the
Content-Security-Policy can be this strict with zero PostHog-specific
allowance needed). No code change needed.

**What's still needed:** `ANALYTICS_PROVIDER=posthog`,
`POSTHOG_API_KEY` from a real PostHog project, `POSTHOG_HOST` if EU data
residency is required.

## 13. Monitoring — PARTIALLY IMPLEMENTED (uncaught errors only)

`src/instrumentation.ts` wires Sentry into the server and edge runtimes
(`SENTRY_DSN`, optional — unset means no-op, exactly as before this
existed): any uncaught exception in a Server Component, Server Action, or
Route Handler now reaches Sentry, with a `beforeSend` scrub that strips
user context, cookies, auth headers, request bodies, and email-shaped
substrings in the error text before the event leaves the process. No
browser/client SDK — this app has never loaded a client-side third-party
script, and adding one would need a CSP `connect-src` change; that's a
separate decision, not bundled into this.

That is the crash layer only. The richer contract below — turning
`recordProviderTelemetry`'s already-structured data (every AI/email/
billing/wallet provider call, whether it threw or just returned a
"failure" result) into alerts — is still **not implemented**:

- **What must be logged:** every provider call already goes through
  `recordProviderTelemetry` (`src/server/providers/telemetry.ts`) — a
  fixed, secret-free shape (category/provider/operation/result/
  durationMs/errorCode/requestId/organizationId). A future Sentry/PostHog
  wiring hooks in here, not at each of the ~15 call sites individually.
- **What must be measured:** provider failure rate by category (AI,
  email, billing, wallet), webhook rejection rate (signature failures,
  amount mismatches), rate-limit trip rate, and the existing
  `/internal/automation/health` signal (Phase 9) — already a real,
  working liveness/readiness check for the one background process this
  app has.
- **What must trigger an alert:** a billing-webhook signature-verification
  failure rate above baseline (possible forgery attempt), any AI/email/
  wallet provider in sustained `failure` state, and the automation
  health endpoint reporting unhealthy.
- **What must be redacted, always:** everything `SECURITY.md` and
  `recordProviderTelemetry`'s own doc comment already forbid — API keys,
  passwords, session tokens, wallet keys, webhook secrets, `Authorization`
  headers, cookies, full payment payloads, raw webhook bodies.

**What's still needed:** choosing and connecting a real vendor — a
Phase 24+ decision, not this phase's to make.

## 14. Vercel — READY AFTER CONFIG

**Corrected from an earlier "BLOCKED" verdict** (Phase 23) after a closer
re-audit for the Vercel production deployment phase, once Vercel became
this project's actual, decided target rather than a hypothetical one.
`src/server/db/client.ts`'s singleton pattern (one `PrismaClient`/
`pg.Pool` at module load) is not, on its own, incompatible with Vercel —
it is the officially Prisma-recommended pattern for Next.js on serverless
too (module-scope caching survives across warm invocations of the same
instance automatically; no code needed to make that true). The real risk
was mischaracterized as "the pattern is wrong" when it is actually
"*aggregate* connections across many concurrently warm serverless
instances can exceed Postgres's `max_connections`" — a real risk, but the
well-known, standard-solution kind, not an architectural rewrite.

**Resolution, implemented this phase — zero business-logic changes:**
1. `prisma.config.ts` now reads an optional `DIRECT_URL` (falls back to
   `DATABASE_URL` when unset) for its own CLI-only connection — Prisma's
   migration engine needs a session-persistent (non-pooled) connection for
   its advisory lock, which a transaction-mode pooler can't provide. The
   *running app* is untouched: it always connects via `DATABASE_URL`
   directly (`src/server/db/client.ts`), never through this file.
2. `.env.example` and `DEPLOYMENT.md#production-hosting-model` document
   the two values a Vercel deployment needs: `DATABASE_URL` = a *pooled*
   connection string (Neon's pooled endpoint, Supabase's port-6543
   pooler, or PgBouncer), `DIRECT_URL` = the *non-pooled* one for
   migrations.
3. `DATABASE_POOL_MAX` should be set low (1–3) for this deployment via a
   Vercel environment variable — no code change, the field already exists
   and is already read from the environment.

No filesystem, in-memory-between-requests, or local-scheduler assumptions
were found elsewhere (`grep` for `fs`/`writeFileSync`/`setInterval`/
module-level mutable caches across `src/server` came back empty beyond
the Prisma singleton pattern above and Next's own dev-mode HMR global,
which is dev-only and already guarded by `NODE_ENV !== "production"`).
Rate limiting is already Postgres-backed, not in-memory
(`src/server/rate-limit/service.ts`) — genuinely serverless-safe on its
own. The scheduler (`/internal/automation/tick`) is already an
externally-triggered HTTP endpoint, not an in-process timer — Vercel Cron
(or any scheduler capable of an authenticated HTTPS POST) can drive it,
though no `vercel.json` cron entry has been added (automation is
opt-in/off by default — add one only once automation is actually wanted
in production). No route opts into Vercel's Edge Runtime (which genuinely
would be incompatible with the `pg` driver) — confirmed by direct search,
not assumed.

**Not independently confirmed by this phase** (requires a real Neon
account, which this phase was explicitly told not to create): that Neon's
actual pooled-connection behavior under the `@prisma/adapter-pg` +
node-postgres driver combination this codebase uses is fully
prepared-statement-safe under real concurrent load. The `DIRECT_URL`/
migration-engine finding above is confirmed against Prisma's own current
documentation with high confidence; this narrower runtime-driver nuance
is lower-confidence and worth confirming with a real smoke test once a
real Neon database exists (see the Vercel deployment phase's own report
for the exact provisioning steps).

**What's still needed:** you provision the real Neon database (this phase
was explicitly told not to) and set the resulting `DATABASE_URL`/
`DIRECT_URL`/`DATABASE_POOL_MAX` as Vercel environment variables — see
that phase's final report for the exact steps.

## 15. Domain — NOT IMPLEMENTED (documentation only, no domain purchased)

No domain purchased or connected — none should be, per this phase's
scope. Documented for whenever one exists:

- **Production domain:** placeholder `https://app.paynora.example` used
  everywhere below; replace consistently, not per-endpoint.
- **www/non-www:** pick one canonical form and redirect the other at the
  DNS/proxy layer — no code in this app assumes either.
- **HTTPS:** required — Auth.js's secure-cookie behavior and every
  webhook signature scheme assume it implicitly.
- **`APP_BASE_URL`:** must be set to the real origin (`src/lib/env.ts`) —
  every password-reset/invitation email link is built from this; left at
  the `http://localhost:3000` default, every such link in production
  would point at localhost.
- **YooKassa webhook URL:** `https://<domain>/api/webhooks/billing` —
  registered once in the YooKassa merchant dashboard, not
  per-organization (one global route — see `docs/billing-provider.md`).
- **Alchemy wallet webhook URL:** `https://<domain>/api/webhooks/wallet/<org-slug>` —
  per-organization, registered when each org connects a wallet (see
  `docs/wallet-architecture.md`).
- **Auth callback:** no OAuth provider exists, so there is no third-party
  callback URL to register — only `AUTH_URL`/trust-host needs the real
  origin (see #5).

**What's still needed:** buy the domain, point DNS at wherever #14 is
resolved to, set `APP_BASE_URL`/`AUTH_URL`, register the two webhook
URLs with their respective vendors.

## 16. Webhooks — READY

Both webhook routes (`/api/webhooks/billing`,
`/api/webhooks/wallet/[orgSlug]`) were re-audited this phase against the
brief's own checklist and found already correct — see #6 in the final
report for the point-by-point mapping (signature verification,
idempotency via unique constraint not check-then-insert, organization
resolution never trusted from the request body, amount/currency
verification, malformed-payload handling via the framework's own
try/catch-free JSON body validation, unknown-event handling, no error
detail ever leaked in a response body). Nothing needed changing.

**What's still needed:** nothing architecturally — see #6/#10 above for
the real credentials each webhook's own provider needs.

## 17. Security — READY

- **Headers:** `next.config.ts` now sets `Content-Security-Policy`
  (`default-src 'self'`; no external script/style/font/image sources are
  needed — this app loads none), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` (+ CSP `frame-ancestors 'none'`),
  `Referrer-Policy: strict-origin-when-cross-origin`, and a minimal
  `Permissions-Policy`. Verified against a real browser session (#19) —
  no console CSP violations, no broken styling.
- **Rate limiting:** unchanged, already Postgres-backed and shared across
  every caller (`src/server/rate-limit/service.ts`) — auth, AI
  generation, Copilot, communication sends, and operator runs all
  already go through it (`docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md`
  P0-1/P1-7). No second rate-limit system was created.
- **Secret/logging redaction:** see #3 above for the one real gap found
  and closed (Alchemy).
- **Automated gate:** `npm run production:check` (see #17 header below —
  this numbering matches the phase brief's own stage list, not a new
  section) runs static, configuration, database, security, test-suite,
  and build validation in one command, requires no real production
  credential, and never makes a network call.
- **`npm audit`:** 5 pre-existing high-severity advisories, all inside
  `prisma`'s own CLI toolchain (`deepmerge-ts`, `fast-uri`, `mysql2` —
  the last is MySQL support this project never uses; Postgres-only since
  Phase 1). None are runtime dependencies of the deployed app. A fix
  requires downgrading to `prisma@6.19.3`, which would undo the Prisma 7
  upgrade every recent phase's schema work depends on — not undertaken
  in this phase; flagged for a dedicated dependency-review pass
  (`docs/dependency-license-review.md` already covers this kind of
  review; not re-run in full here).

**What's still needed:** nothing to keep the current feature set secure;
re-run `docs/dependency-license-review.md`'s process periodically.

## 18. Backups — READY (documented; execution needs a real database)

`DEPLOYMENT.md#backups--point-in-time-recovery` already documents backup/
restore expectations and connection pooling guidance — written in an
earlier phase, unchanged here, still accurate.

**What's still needed:** a real Postgres provider's actual backup/PITR
feature enabled, once #4/#14 are resolved.

## 19. Incident response — NOT IMPLEMENTED (no on-call, no runbook yet)

No incident-response runbook exists. What this phase's audit did confirm
as real, existing signal an incident response process could use:
`/internal/automation/health`, `recordProviderTelemetry`'s structured
failure logs, and the webhook routes' own explicit rejection reasons
(`signature_verification_failed`, amount mismatch logged server-side).

**What's still needed:** an actual runbook and an actual on-call
process — a business decision, not a code change.

## 20. Launch checklist

Everything above, collapsed to one list. Check these in roughly this
order:

1. Decide the hosting model (#14) — this gates everything after it.
2. Provision production Postgres (#4/#18), run `prisma migrate deploy`.
3. Buy and point the domain (#15); set `APP_BASE_URL`/`AUTH_URL`.
4. Set `AUTH_SECRET` (a real, freshly generated one — never reuse a dev
   value).
5. Configure and smoke-test each integration you actually need, one at a
   time (#6–#12), each via its own `npm run smoke -- <target> --confirm`
   before trusting it.
6. Register the two webhook URLs with YooKassa/Alchemy (#15).
7. Run `npm run production:check` against the real, final `.env`
   (without `--confirm`-gated smoke tests — those stay manual, see #17
   of the phase brief and this doc's #13/#17).
8. Decide on a monitoring vendor (#13) and an incident-response process
   (#19) before real users depend on this.

None of the above happened in this phase. This document describes what
is ready to receive that work, not that the work is done.
