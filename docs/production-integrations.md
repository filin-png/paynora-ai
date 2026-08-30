# Production Integrations & Real Intelligence (Phase 14)

This phase turned PAYNORA's existing provider architecture
(`docs/integration-architecture.md`) into real integrations for four
capabilities that were previously abstraction-only or partially real —
**Wallet** (Phase 13's `WalletProvider` got its first real adapter),
**Analytics** (new capability), and **Web Intelligence** (new
capability) — while confirming AI, Email, and Messaging were *already*
real from earlier phases and needed no new adapter, only an audit.

Every integration follows the same five-part shape established since
Phase 6 — see `docs/integration-architecture.md#provider-architecture`
for the full pattern (`types.ts` → `service.ts` → `providers/none.ts` →
`providers/<vendor>.ts` → `providers/fake.ts`, test-only). This document
does not repeat that architecture; it documents what's specific to each
integration: credentials, sandbox vs. production setup, cost, failure
behavior, and security boundaries. For domain-level detail (state
machines, invariants, idempotency) see `docs/wallet-architecture.md`,
`docs/communications.md`, and `docs/ai-architecture.md`.

## Contents

1. [AI (audit only — no new adapter)](#ai)
2. [Analytics](#analytics)
3. [Email (audit only — no new adapter)](#email)
4. [Messaging (audit only — no new adapter)](#messaging)
5. [Wallet](#wallet)
6. [Web Intelligence](#web-intelligence)
7. [Internationalization status](#internationalization-status)
8. [European access](#european-access)
9. [Test layers](#test-layers)
10. [Cost control](#cost-control)
11. [Observability](#observability)
12. [UI integration status](#ui-integration-status)

---

## AI

**Status: already real before this phase.** OpenRouter and Mistral
adapters (`src/server/ai/providers/{openrouter,mistral}.ts`) were built
in Phase 6 and hardened in Phase 9/11.5 — see `docs/production-providers.md`
for the full Phase 11.5 audit. This phase re-verified, and did not change:
timeout + cancellation (`AbortController` in `runAIGeneration`), quota
checks before every provider call, the deterministic non-AI fallback path
(every AI-assisted feature works with `AI_PROVIDER=none`), and that no AI
code path can silently send a financial communication (drafts always
require human approval before `sendCommunication` — see
`docs/communications.md`).

- **Env vars:** `AI_PROVIDER` (`none`/`gigachat`/`yandex`/`openrouter`/
  `mistral`), `AI_PROVIDER_FALLBACK`, `OPENROUTER_API_KEY`,
  `OPENROUTER_MODEL`, `MISTRAL_API_KEY`, `MISTRAL_MODEL`.
- **Cost:** OpenRouter passes through provider token pricing with no
  markup (roughly $0.08–$15 per million tokens depending on model) plus a
  5.5% fee on credit purchases; Mistral's own API is $0.10–$6/M tokens
  depending on model. Both are pay-per-token, no free tier beyond
  whatever trial credit the vendor offers at signup.
- **Rate limit:** `RATE_LIMIT_AI_GENERATION_PER_HOUR` (default 50/org/hour).
- **Not implemented:** `gigachat`/`yandex` remain recognized-but-not-built
  (unchanged from Phase 3 — no accurate OAuth/mTLS flow was available to
  build and test correctly without a real account).

## Analytics

**Status: new in this phase.** `AnalyticsProvider` is a new abstraction
(`src/server/analytics/types.ts`) — `capture(event)` never throws, so a
broken analytics vendor can never break a real user action.
`trackEvent()` (`src/server/analytics/events.ts`) is the one call site
every domain caller uses; it enforces an allowlist of event names and
strips any property whose key looks sensitive (`SENSITIVE_KEY_PATTERN`)
before an event ever reaches a provider — so even a caller mistake can't
leak a secret-shaped value.

| Field | Detail |
| --- | --- |
| Adapter | `src/server/analytics/providers/posthog.ts` — plain `fetch` POST to PostHog's Capture API, no vendor SDK |
| Env vars | `ANALYTICS_PROVIDER=posthog`, `POSTHOG_API_KEY`, `POSTHOG_HOST` |
| Sandbox setup | Create a free PostHog project (any plan), copy its Project API Key. No separate sandbox/production PostHog concept exists — use a dedicated project for pre-production testing. |
| Production setup | Same as sandbox, pointed at your production PostHog project. Set `POSTHOG_HOST=https://eu.i.posthog.com` for EU data residency — see [European access](#european-access). |
| Webhook config | None — PostHog Capture is outbound-only (PAYNORA → PostHog); there is nothing for PostHog to call back. |
| Cost | Free tier: 1,000,000 events/month. Beyond that, step-down usage pricing starting at $0.00005/event. PAYNORA fires roughly one event per significant business action (signup, invoice sent, payment recorded, ...) — see the allowlist below — so realistic organizations stay in the free tier for a long time. |
| Rate limit / volume control | None needed — analytics volume is bounded by real user/business actions, not a configurable knob (same reasoning as the wallet webhook volume). |
| Failure behavior | Every failure (timeout, non-2xx, network error) is caught inside the adapter and swallowed; `capture()` always resolves. A 5-second `AbortController` timeout prevents a slow vendor from ever blocking a caller. |
| Security boundaries | `ANALYTICS_EVENTS` allowlist (`src/server/analytics/events.ts`) is the only set of event names ever sent — no free-form event name from anywhere in the app can reach PostHog. Never sends a private key, secret, full PII, auth token, or raw financial document — only organization/user ids and small non-sensitive properties (currency codes, channel names, network names). Analytics is disableable by leaving `ANALYTICS_PROVIDER` unset (`none`, the default) — a real, harmless no-op, not a stub that silently queues events. |
| Remaining manual steps | Create a real PostHog project and set the two env vars. No code change needed. |

**Events currently tracked** (see `ANALYTICS_EVENTS` for the authoritative
list): `user_signed_up`, `user_signed_in`, `invoice_created`,
`invoice_sent`, `payment_recorded`, `wallet_connected`,
`crypto_payment_requested`, `crypto_transaction_detected`,
`crypto_transaction_confirmed`. The brief's "collection priority viewed"
and "Copilot used" events are intentionally not implemented — the Phase
12 Intelligence MVP (Risk Copilot) those events describe was never merged
to `main` in this codebase; there is no call site to track from. Adding
those two events is a one-line `trackEvent()` call each, whenever that
feature exists.

**Fire-only-after-commit discipline:** every call site that both writes
financial state and tracks an event captures the transaction's resolved
result first (`const result = await prisma.$transaction(...)`) and only
calls `trackEvent()` after that await resolves — so a rolled-back
transaction can never produce an analytics event describing something
that didn't actually happen. See `src/server/ar/invoices.ts`,
`src/server/ar/payments.ts`, `src/server/communications/send.ts`,
`src/server/wallet/{wallets,payment-requests,transactions,reconciliation}.ts`.

## Email

**Status: already real before this phase.** SMTP adapter
(`src/server/email/providers/smtp.ts`), built Phase 4, audited Phase
11.5 — see `docs/production-providers.md`. This phase re-verified
unchanged: the human-approval workflow (`ActionProposal` must be
`APPROVED` before a draft can even be prepared), that no AI code path can
call `sendCommunication` directly, delivery/error handling
(`dispatchEmail`'s rejected-vs-unknown-outcome distinction), and that
`EMAIL_PROVIDER`/`SMTP_*`/`PAYNORA_EMAIL_FROM` are already externalized
env vars with no default value.

## Messaging

**Status: already real before this phase.** Telegram adapter
(`src/server/messaging/providers/telegram.ts`), built Phase 8. This phase
re-verified unchanged: send success/failure/timeout is normalized the
same way the email adapter is (`dispatchMessage`), idempotency uses the
same `idempotencyKey` discipline as email, and delivery state is tracked
through the same `Communication`/`DeliveryAttempt` model — no second
messaging platform was introduced (the brief's "don't introduce
unnecessary platforms" instruction), since Telegram already covers the
product's one shipped non-email channel.

## Wallet

**Status: new real adapter this phase** — Phase 13 shipped the
`WalletProvider` abstraction and a full, tested domain (state machine,
reconciliation, webhook pipeline) with only a `none`/`fake` provider
behind it. This phase adds the first real adapter. See
`docs/wallet-architecture.md` for the full domain design (state machine,
reconciliation, financial invariants) — this section covers only what's
specific to the real Alchemy adapter.

| Field | Detail |
| --- | --- |
| Adapter | `src/server/wallet/providers/alchemy.ts` — implements `WalletProvider` against three distinct Alchemy surfaces: Enhanced/JSON-RPC APIs (balances, transaction receipts), the Notify API (webhook address management), and pure client-side EIP-191 signature recovery (`@noble/curves`/`@noble/hashes`) for ownership verification — no Alchemy call needed for that step. |
| Networks supported | `ETHEREUM`, `POLYGON`, `BSC` (Alchemy's `eth-mainnet`/`polygon-mainnet`/`bnb-mainnet`). Any other `WalletNetwork` value throws a clear "not supported by this adapter" error rather than silently no-oping. |
| Env vars | `WALLET_PROVIDER=alchemy`, `ALCHEMY_API_KEY` (Enhanced/JSON-RPC auth), `ALCHEMY_AUTH_TOKEN` (Notify/webhook-management API auth — a **different** credential from the API key), `ALCHEMY_WEBHOOK_ID` (a pre-created Address Activity webhook's id), `ALCHEMY_WEBHOOK_SIGNING_KEY` (that webhook's own HMAC signing key, shown once at creation). |
| Sandbox setup | Create a free Alchemy account, an app on a testnet (e.g. Sepolia — note: this adapter's `ALCHEMY_NETWORK_SLUG` table only maps mainnet slugs today; testing against a testnet requires temporarily adding a slug entry, or testing read-only calls like `getBalances` against mainnet with a well-known address, which is what `alchemy.sandbox.test.ts` and `npm run smoke -- wallet` both do). Create one Address Activity webhook in the Alchemy dashboard pointed at `https://<your-dev-tunnel>/api/webhooks/wallet/<org-slug>`. |
| Production setup | Same four credentials against a mainnet Alchemy app. Point the webhook at your real public origin: `https://<your-domain>/api/webhooks/wallet/<org-slug>`. |
| Webhook config | `POST /api/webhooks/wallet/[orgSlug]` (`src/app/api/webhooks/wallet/[orgSlug]/route.ts`) resolves the organization by slug **first** (404 if unknown, before any provider or signature work — so an unknown-org probe never even reaches signature verification), returns 503 if `WALLET_PROVIDER=none`, then calls `ingestWalletWebhookEvent` which verifies the `X-Alchemy-Signature` header (hex HMAC-SHA256 over the raw request body, keyed by `ALCHEMY_WEBHOOK_SIGNING_KEY`) before parsing anything — an invalid signature returns 401 and never mutates financial state (see `docs/wallet-architecture.md#8-webhook--event-pipeline` for the full idempotency/replay-protection pipeline this feeds into, unchanged by this phase). |
| Cost | Free tier: 30M compute units/month, 5 apps, 5 webhooks. Beyond that: $0.45/M compute units for the next 300M, $0.40/M after. A webhook delivery costs roughly 40 CUs; a `getBalances` call is a handful of CUs. Realistic organizations stay well within the free tier. |
| Failure behavior | `connectWallet`/`getBalances`/`inspectTransaction` use a 10-second `AbortController` timeout and throw a normalized error on timeout/non-2xx — never a best-guess result. `verifyAndParseWebhookEvent` throws `WalletWebhookVerificationError` (never returns a best-guess parse) on any signature mismatch or malformed payload. |
| Security boundaries | No private key or seed phrase is ever requested, stored, or transmitted — `connectWallet` only registers an address to watch. `verifyOwnership` verifies a signed-message proof the *user's own wallet* produced (EIP-191 recovery) — PAYNORA never signs anything. Webhook signature verification uses `timingSafeEqual` (not `===`), mirroring `src/server/scheduler-auth.ts`'s existing discipline. All four credentials are read only in `src/server/wallet/service.ts`/`providers/alchemy.ts`, both server-only. |
| Remaining manual steps | Create a real Alchemy account, an app, and one Address Activity webhook per production organization's public webhook URL; set the four env vars. `coinbase`/`privy` remain recognized-but-not-implemented (no accurate SDK/OAuth flow available to build and test correctly without a real account of that type). |

## Web Intelligence

**Status: new in this phase.** `WebSearchProvider` is a new abstraction,
deliberately **separate from `AIProvider`** — a different vendor account,
different rate limit, different cost line, and a different failure mode
(a search failure should never look like an AI generation failure).

| Field | Detail |
| --- | --- |
| Adapter | `src/server/websearch/providers/anthropic.ts` — a plain `fetch` POST to the Anthropic Messages API (`https://api.anthropic.com/v1/messages`) with the server-side `web_search_20250305` tool enabled. Anthropic performs the actual search, page retrieval, and citation extraction server-side; the adapter only parses the response. |
| Env vars | `WEB_SEARCH_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-opus-5`). This is a separate Anthropic account/key from any AI provider PAYNORA's own Operator/Copilot features might use — `AI_PROVIDER` never selects `"anthropic"` in this codebase; the two are independent vendor relationships even if both happen to be Anthropic. |
| Sandbox setup | No separate sandbox concept exists for this API — a real API key with web search enabled (Claude Console → Settings → Privacy) makes a real, billed call every time. Use a low `maxUses`/`RATE_LIMIT_WEB_SEARCH_PER_HOUR` during development to bound cost — see [Test layers](#test-layers) for how this is kept out of normal `npm run test`. |
| Production setup | Same key, no additional webhook/callback configuration — this is a synchronous request/response API, not an event-driven one. |
| Webhook config | None — there is no webhook for this integration. |
| Cost | $10 per 1,000 searches, plus normal token costs for the surrounding Messages API call (a few hundred to low-thousands of tokens per query depending on answer length). A "Deep Research" call (below) can use up to 10 searches in one call — a single deep-research invocation could cost up to $0.10 in search fees alone plus tokens. |
| Rate limit | `RATE_LIMIT_WEB_SEARCH_PER_HOUR` (default 20/org/hour), checked in `tryWebSearch`/`runDeepResearch` before any provider call — an exhausted limit returns `null` without spending anything. |
| Search caps | `MAX_SEARCHES_PER_CALL = 10` is a hard ceiling enforced in `src/server/websearch/gateway.ts`, independent of what a caller asks for — `tryWebSearch`'s `maxUses` option is clamped to this ceiling even if a caller requests more. "Deep Research" (`runDeepResearch`, `src/server/websearch/deep-research.ts`) is **not a separate multi-step orchestrator** — it deliberately reuses the exact same `search()` primitive with the same `MAX_SEARCHES_PER_CALL` ceiling and a longer (60s, overridable) timeout, because Anthropic's `web_search` tool already performs search → dedupe → compare → synthesize → cite internally within one call when given a higher `max_uses`. This avoids inventing a second, duplicate search abstraction (the brief's own "never invent a duplicate abstraction" instruction) while still enforcing "never unlimited autonomous research" (a fixed cap, a fixed timeout, no recursive follow-up searches). |
| Failure behavior | 30-second `AbortController` timeout (`WebSearchTimeoutError`); non-2xx or malformed response → `WebSearchProviderError`. Both `tryWebSearch` and `runDeepResearch` never throw to their caller — any failure (disabled, rate-limited, timeout, provider error) returns `null`, so a broken search vendor degrades to "no search result" rather than breaking whatever feature called it. |
| Prompt-injection defense | `WEB_SEARCH_SYSTEM_PROMPT` (`src/server/websearch/providers/anthropic.ts`) is a **fixed, non-interpolated constant** — it never contains the query or any search result — instructing the model, before it ever sees a single search result, that web content is untrusted data, never instructions, and that it must never fabricate a source. This is what makes "the AI must distinguish system instructions / PAYNORA context / user request / external web content" concretely true rather than aspirational: the untrusted-content boundary is established structurally (a prompt that literally cannot be reached by injected text), not by hoping the model behaves. |
| Citations | Every citation the adapter returns is deduped by URL and carries `{title, url, domain, citedText}` — sourced directly from Anthropic's `web_search_result_location` citation blocks, never synthesized. The adapter never invents a citation for an uncited claim. |
| Security boundaries | `ANTHROPIC_API_KEY` is read only in `src/server/websearch/service.ts`, server-only. No search query or result is ever logged with content — only the operation/duration/success-failure shape (see [Observability](#observability)). |
| Remaining manual steps | Create/reuse an Anthropic API key with web search enabled and set the two env vars. `yandex` remains recognized-but-not-implemented (research confirmed pricing/quota but not enough live-verified request/response detail to implement confidently without risking a wrong implementation). |
| Automatic search decision | `decideAndSearch` (`src/server/websearch/orchestrator.ts`, added post-merge) closes the "AI decides if fresh info needed" step from the architecture diagram: it asks PAYNORA's own `AIProvider` (via `tryGenerateStructured`, gated by `checkAiGenerationQuota` — the same AI-generation quota drafting/insights use) a structured yes/no — `{needsSearch, directAnswer?}` — built from a fixed, non-interpolated system prompt (`src/server/websearch/decision.ts`) with the query passed as structured `input`, never concatenated into the prompt. `needsSearch: true` calls `tryWebSearch`; `false` returns the model's own `directAnswer` with `citations: []`/`searchesUsed: 0`, spending nothing on a real search. Never throws and never fabricates a search-backed answer: if the AI can't decide (disabled, quota-exhausted, provider error) it returns `null` rather than guessing, and if the AI says search is needed but the search itself fails, it also returns `null` rather than falling back to a possibly-stale non-search answer. Still not wired to any UI or automation trigger — it's a complete, real, tested decision layer any future feature (e.g. a Risk Copilot) can call, not a standalone product surface itself. |

## Internationalization status

**Real, working foundation — deliberately partial coverage, documented
honestly rather than claimed as complete.** `src/lib/i18n/` is a real
resource-dictionary architecture (not duplicated UI components): typed
`en`/`ru` dictionaries with an enforced identical key shape
(`dictionaries.test.ts` fails if a key exists in one locale but not the
other), a `Locale` persisted in a cookie (`paynora_locale`), a Server
Action (`setLocaleAction`) that sets it and revalidates every layout, and
a `LocaleSwitcher` client component that calls that action directly — a
real language selector, not a decorative toggle: choosing "RU" genuinely
changes what the server renders on the next request, because
`getLocale()`/`getDictionary()` are read at the top of each page/layout
and the resolved strings are threaded down as props, the same way
`requireOrganizationMembershipForPage`'s tenant context is threaded down
today.

**What responds to the switcher today:** the landing page's nav (Sign
in/Get started) and hero section (badge, headline, subtitle), and —
visible on every authenticated page — the app shell's sidebar/mobile-nav
navigation labels (Overview/Invoices/Customers/Action Center/Automation/
Wallet/Settings, "Switch organization", open/close-navigation labels) and
Settings → Integrations' category labels (AI generation/Email/
Messaging/.../Web search). The switcher itself is present in both the
landing nav and the authenticated app header, so it's reachable from
everywhere translated content exists.

**What does not respond yet — an honest, explicit gap, not a
half-finished rollout:** every other screen (Invoices, Customers, Action
Center, Automation, Wallet, all forms, all table columns, all empty/
error states) remains English-only, hardcoded inline, same as every
prior phase. This was a deliberate scope decision, not an oversight: a
full sweep of every string across a dozen-plus pages built across 13
prior phases is a substantial body of work in its own right, and doing
it hastily risks exactly the kind of half-translated screen (some
strings keyed, most not) that would be worse than a clearly-scoped
foundation. The architecture itself has no per-page limitation — adding
a new translated page is "thread `dict`/`locale` down as a prop and
replace a hardcoded string with a dictionary lookup," the same pattern
used for the pages above — so extending coverage is mechanical, not an
architecture change.

**Dates, numbers, currency:** `Intl.NumberFormat`/`Intl.DateTimeFormat`
are already used for money formatting (`src/server/ar/money.ts`), but
today with a fixed `"en-US"` locale argument, independent of the viewer's
chosen UI locale — so a RU-locale viewer sees `$1,234.56`-style grouping
even once the surrounding UI is in Russian. This is an accurate,
unfixed gap: threading the resolved `Locale` into `getFormatter` was not
done this phase, specifically to avoid changing the *default* (`en-US`)
formatting behavior every existing test and every non-i18n-aware call
site currently depends on — a locale-aware formatter is a natural next
step once more of the UI is translated and actually needs it.

## European access

A review of deployment blockers for an EU-based organization using
PAYNORA today:

| Concern | Status |
| --- | --- |
| Currency | `Money`/`Currency` handling (`src/server/ar/money.ts`) is already currency-code-driven, not USD-only — EUR/GBP/etc. work today. |
| Timezone | All financial timestamps are stored as UTC `DateTime` in Postgres; no code path assumes a specific timezone. Display formatting uses the server's/browser's locale via `Intl`, not a hardcoded format. |
| Language | Real EN/RU switcher, partial coverage (nav + landing hero + integration labels) — see [Internationalization status](#internationalization-status). Most screens remain English-only; this is still a real adoption blocker for a non-English-speaking EU team on any of the untranslated screens. |
| Email delivery | SMTP works with any EU-based relay — no vendor lock-in (`docs/production-providers.md`). |
| Analytics data residency | `POSTHOG_HOST=https://eu.i.posthog.com` routes analytics through PostHog's EU-hosted infrastructure instead of the US default — a one-line env var change, already documented in `.env.example`. |
| AI/Web Search data residency | Neither OpenRouter, Mistral, nor Anthropic's web search offers a PAYNORA-configurable EU-only processing guarantee in this integration layer — a query or draft sent to any of them may be processed outside the EU. This is a real, undocumented-elsewhere gap for a strict-residency EU deployment. |
| Cookie consent | Not implemented — there is no cookie-consent banner or mechanism in this codebase. PostHog's client-side capture (if ever added to a browser context — today all analytics calls originate server-side) would need one; today's server-side-only `trackEvent` calls don't set any browser cookie themselves, but this has not been legally reviewed. |
| GDPR compliance | **Not claimed.** Setting `POSTHOG_HOST` to the EU region, or that data is UTC/currency-agnostic, is infrastructure readiness, not legal compliance. A real GDPR posture needs: a data processing agreement with every vendor whose account is configured (PostHog, Alchemy, Anthropic, OpenRouter/Mistral, the SMTP relay), a documented legal basis for each category of processing, a privacy policy, a data-subject-request process, and likely legal counsel review specific to the jurisdiction PAYNORA is deployed in — none of which this phase performed or can perform. |

**Remaining legal/compliance work** (explicitly not done, not startable
by an engineering phase alone): DPAs with each configured vendor, a
published privacy policy, a cookie-consent mechanism if/when any
client-side tracking is added, a data-subject-request handling process,
and jurisdiction-specific legal review.

## Test layers

Four distinct layers, matching the brief's "production credentials NOT
required for normal CI" requirement:

1. **Unit tests** (`*.test.ts`, e.g. `posthog.test.ts`, `alchemy.test.ts`,
   `anthropic.test.ts`) — mocked `fetch`/network, always run, no
   credentials, part of `npm run test` and CI. This is where the large
   majority of new Phase 14 test coverage lives (analytics
   allowlist/redaction, EIP-191 signature recovery including a real
   generated-keypair self-test, webhook HMAC verification, citation
   parsing/dedup, rate-limit/timeout/cap behavior).
2. **Sandbox integration tests** (`*.sandbox.test.ts`, e.g.
   `posthog.sandbox.test.ts`, `alchemy.sandbox.test.ts`,
   `anthropic.sandbox.test.ts`) — real network calls against real vendor
   endpoints, opt-in only. Matched by the same `src/**/*.test.ts` glob
   `vitest.config.mts` already uses, but every file's top-level
   `describe` block is wrapped in `describe.skipIf(process.env.RUN_EXTERNAL_INTEGRATION_TESTS !== "true")`
   — so the file is always discovered and reported as *skipped*, never
   silently absent, but never makes a real network call unless
   explicitly opted in:
   ```bash
   RUN_EXTERNAL_INTEGRATION_TESTS=true POSTHOG_API_KEY=... ALCHEMY_API_KEY=... ANTHROPIC_API_KEY=... npm run test
   ```
   Each is deliberately read-only or low-cost/reversible: the PostHog
   test posts a clearly-named test event; the Alchemy test only reads
   balances for the zero address (`0x000...000`) — never a specific
   person's or organization's real wallet; the Anthropic test performs
   exactly one real (billed) search.
3. **Production smoke** (`npm run smoke -- <target> --confirm`,
   `scripts/live-smoke-test.ts`, extended this phase with `analytics`,
   `wallet`, and `websearch` targets alongside the pre-existing `ai`,
   `email`, `telegram`) — a dev-only, manual CLI that refuses to run
   under `CI`/`VITEST`, requires `--confirm`, and makes one real call
   against whatever provider is actually configured in the local
   environment. This is the tool an operator runs once, by hand, after
   configuring real production credentials, to confirm the real
   integration actually works before relying on it.
4. **Domain-level unit tests already covering the full blockchain flow**
   (`transactions.test.ts`, `reconciliation.test.ts`,
   `wallets.test.ts`, `payment-requests.test.ts`, `route.test.ts`,
   Phase 13) — successful/duplicate/delayed/failed/malformed/
   invalid-signature/wrong-network/wrong-asset/concurrent scenarios,
   all against the deterministic `fake` `WalletProvider`, unchanged and
   still passing with the real Alchemy adapter now available alongside
   it (the domain layer never knows which one is active).

None of layers 1 or 4 requires any credential. CI never sets
`RUN_EXTERNAL_INTEGRATION_TESTS`, so layer 2 never runs there either —
exactly the brief's "production credentials NOT required for normal CI."

## Cost control

| Provider | Purpose | Free tier | Starting cost | Per-request cost | Rate limit (this codebase) | Main cost driver |
| --- | --- | --- | --- | --- | --- | --- |
| OpenRouter | AI drafting/insights | Trial credit only, no ongoing free tier | Pay-per-token | ~$0.08–$15/M tokens (model-dependent) | `RATE_LIMIT_AI_GENERATION_PER_HOUR` (50/org/hr) | Model choice + draft length |
| Mistral | AI drafting/insights (fallback) | Trial credit only | Pay-per-token | ~$0.10–$6/M tokens (model-dependent) | same policy as above | Model choice + draft length |
| PostHog | Analytics | 1,000,000 events/month | $0 until free tier exceeded | ~$0.00005/event above free tier | None (bounded by real business actions) | Event volume at scale |
| Alchemy | Wallet/blockchain | 30M compute units/month, 5 webhooks | $0 until free tier exceeded | $0.45/M CUs (next 300M), $0.40/M after | None (bounded by real on-chain event rate) | Webhook delivery volume + balance/tx lookups |
| Anthropic (web search) | Web Intelligence | None — every search is billed | Pay-per-search + tokens | $10/1,000 searches + token cost | `RATE_LIMIT_WEB_SEARCH_PER_HOUR` (20/org/hr), `MAX_SEARCHES_PER_CALL` (10/call hard ceiling) | Search count — this is the only integration in this phase with **no free tier at all**, so its rate limit is the most consequential guardrail in this document |
| SMTP | Email | Depends on relay chosen | Varies by vendor | Varies by vendor | `RATE_LIMIT_COMMUNICATION_SEND_PER_HOUR` (100/org/hr) | Send volume |
| Telegram Bot API | Messaging | Free | $0 | $0 | same policy as SMTP | None — Telegram's Bot API has no usage-based cost |

**Deliberate cost-avoidance decisions already in the code**, beyond the
rate limits above: `tryWebSearch`/`runDeepResearch` check enablement and
the rate limit *before* ever calling the provider, so an exhausted quota
costs nothing; `MAX_SEARCHES_PER_CALL` caps every single call regardless
of what a caller requests, so a bug elsewhere in the codebase can't
accidentally request an unbounded number of searches in one call;
analytics has no per-call cost gate because PostHog's free tier is large
relative to realistic event volume and analytics failures are silently
swallowed anyway (spending nothing extra to protect against a $0 line
item would be its own kind of waste).

## Observability

`recordProviderTelemetry` (`src/server/providers/telemetry.ts`, Phase 6)
already covers every provider category with one fixed, safe shape:
`{category, provider, operation, result, durationMs, errorCode?,
requestId?, organizationId?}` — no field a credential, prompt, search
query, or message body could occupy. This phase's new adapters (PostHog,
Alchemy, Anthropic web search) raise/normalize errors the same way
existing adapters do (a typed error with a `name`/`message`, never a raw
vendor response object), so they compose with this telemetry shape
without any change to it. **Never logged, anywhere in this codebase**:
API keys, auth tokens, private keys, webhook signing secrets, full
request/response bodies, search queries, or AI prompts/completions.

## UI integration status

Settings → Integrations (`src/app/app/[orgSlug]/settings/page.tsx`) reads
`getProviderRegistrySnapshot()`/`getProviderVendorBreakdown()`
(`src/server/providers/registry.ts`) — pure, configuration-derived,
zero-network functions extended this phase to include the two new
`analytics`/`webSearch` categories alongside the existing `ai`/`email`/
`messaging`/`billing`/`wallet` ones. Every category renders one of five
honest states, never a live network probe result:

- **HEALTHY ("Configured")** — a real vendor is selected and its required
  env vars passed boot-time Zod validation. This reports "the
  configuration is valid," not "the vendor is currently reachable" — see
  `docs/integration-architecture.md#health-model` for why a real health
  check (one that would spend AI budget or send a real message) is
  deliberately never performed.
- **DISABLED ("Not configured")** — the category's provider is `none`
  (the default for every category in this phase).
- **UNKNOWN ("Not available yet")** — a recognized-but-unimplemented
  vendor is selected (e.g. `WALLET_PROVIDER=coinbase`,
  `WEB_SEARCH_PROVIDER=yandex`).
- **DEGRADED/DOWN** — reserved in the type for a future real health-check
  mechanism; never produced by this phase, same as every prior phase.

This satisfies the brief's UI requirement structurally: the registry
snapshot has no code path that can report "Connected" for a category
that's only an abstraction with no real adapter behind it, because
`implemented`/`health` are derived from the same `IMPLEMENTED_VENDORS`
table the rest of this document describes, not from a separate,
independently-maintained UI-only claim.
