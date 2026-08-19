# Production AI & Email Providers (Phase 11.5)

An operator-facing checklist for taking PAYNORA's AI and email provider
infrastructure to production. This document does not introduce new
architecture — it audits and lightly hardens what already exists, and
points to the documents that describe it in depth:
`docs/integration-architecture.md` (the full provider architecture, added
Phase 6), `docs/ai-architecture.md` (AI-specific design), and
`docs/communications.md` (the send/delivery state machine).

## What this phase found

Both a real AI provider and a real email provider **already existed**
before this phase, built and hardened across Phase 4 (email), Phase 6
(AI routing + provider architecture), and Phase 9 (production hardening —
timeouts, request cancellation, idempotency, rate limiting). This phase's
job was to audit that infrastructure against a production-readiness
checklist, close the small gaps found, and document the result — not to
build a second provider layer alongside an existing one.

| Requirement | Status before this phase | What this phase did |
| --- | --- | --- |
| Real AI provider, structured output, Zod-validated | OpenRouter + Mistral, both real HTTP adapters (`src/server/ai/providers/{openrouter,mistral}.ts`) | Verified; no change needed |
| AI timeout + cancellation | `runAIGeneration` races a timer and aborts the real `fetch` via `AbortController` (`src/server/ai/gateway.ts`) | Verified; no change needed |
| AI quota checked before provider invocation | `checkAiGenerationQuota` + rate limit, both before `tryGenerateStructured`, at both call sites (`draft.ts`, `insights.ts`) | Verified; no change needed |
| Real email provider | SMTP (`src/server/email/providers/smtp.ts`), works with any SMTP-AUTH relay | Verified; no change needed |
| Email timeout + error normalization | `dispatchEmail` (`src/server/email/gateway.ts`) — rejected vs. unknown-outcome, never conflated | Verified; no change needed |
| Send-path authorization/entitlement/idempotency | `sendCommunication`'s claim/dispatch/finalize CAS state machine, `isAutoSendStillAuthorized` rechecked immediately before every automation-triggered send | Verified; no change needed |
| Credentials never client-side, never logged | Every adapter lives under `src/server/`, `recordProviderTelemetry`'s fixed shape has no field a secret could occupy | Verified; no change needed |
| **SMTP adapter's own request construction tested without network** | **Not covered** — the adapter itself had no test file | **Added** `src/server/email/providers/smtp.test.ts` |
| Readiness view reports sender configuration distinctly | Folded into the email provider's health only | **Added** a distinct "Sender address" readiness check |
| Concrete SMTP setup example in deployment docs | Referenced by variable name only | **Added** a runnable example to `DEPLOYMENT.md` |

## Provider selection (how it works)

Nothing here is new — see `docs/integration-architecture.md#provider-architecture`
for the full five-part shape every category follows
(`types.ts`/`errors.ts`/`gateway.ts`/`providers/none.ts`/`providers/fake.ts`).
In one sentence: an env var (`AI_PROVIDER`, `EMAIL_PROVIDER`, ...) selects
a vendor, a category's `service.ts` (`resolveProviderByName`,
`resolveEmailProvider`) is the only place that resolves it to a real
adapter, and domain code never imports a vendor module directly — so
switching providers is a configuration change, never a code change.

## Configuring AI

```bash
AI_PROVIDER=openrouter        # or mistral
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...          # e.g. a model slug from openrouter.ai/models
```

Optional single fallback, tried only if the primary fails/times out/
returns invalid output:

```bash
AI_PROVIDER_FALLBACK=mistral
MISTRAL_API_KEY=...
MISTRAL_MODEL=...
```

If left unset, `AI_PROVIDER` defaults to `none` — every AI-assisted
feature (reminder drafting, Action Center insights) already has a
deterministic, non-AI fallback and works identically, just without an
AI-generated draft. See `DEPLOYMENT.md#integration--provider-foundation-phase-6`
for the full local-dev walkthrough.

## Configuring email

```bash
EMAIL_PROVIDER=smtp
PAYNORA_EMAIL_FROM=billing@yourdomain.example
SMTP_HOST=smtp.yourprovider.example
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_SECURE=false             # true for port 465 (implicit TLS); false for STARTTLS on 587
```

Works with any SMTP-AUTH relay — a self-hosted server, Yandex Mail, or any
other provider; there is no vendor-specific email adapter (see
`docs/integration-architecture.md#email-no-new-adapter-needed`). If left
unset, `EMAIL_PROVIDER` defaults to `none`: reminder/invitation/
password-reset sends throw a clear `EmailDisabledError` and make no state
change — see [Local development and test behavior](#local-development-and-test-behavior).

## Local development and test behavior

- **Neither provider is required to run the app.** `AI_PROVIDER=none` and
  `EMAIL_PROVIDER=none` are the defaults; every feature that touches
  either degrades to its deterministic/no-op path rather than failing.
- **No automated test ever makes a real network call to either provider.**
  `openrouter.test.ts`/`mistral.test.ts` inject a mocked `fetch`;
  `smtp.test.ts` mocks `nodemailer`; `send.test.ts`/`draft.test.ts` inject
  the deterministic `fake` provider (`src/server/email/providers/fake.ts`,
  `src/server/ai/providers/fake.ts`). `vitest.config.mts` leaves
  `EMAIL_PROVIDER`/`AI_PROVIDER` unset for the whole suite (defaulting to
  `none`) precisely so a test that forgets to inject a fake provider fails
  loudly (`EmailDisabledError`/`null`) instead of silently reaching a real
  vendor.
- **`npm run smoke`** (`scripts/live-smoke-test.ts`) is the one dev-only,
  manual exception — it makes a real call against a real configured
  provider, requires `--confirm`, refuses to run under `CI`/`VITEST`, and
  is never imported by any test file or application code path. See
  `docs/integration-architecture.md#live-smoke-test-phase-8`.
- **Boot-time validation, not runtime surprises.** `src/lib/env.ts`'s
  `superRefine` cross-field checks mean a deployment that selects
  `AI_PROVIDER=openrouter` without `OPENROUTER_API_KEY`/`OPENROUTER_MODEL`
  (or `EMAIL_PROVIDER=smtp` without its required `SMTP_*`/
  `PAYNORA_EMAIL_FROM`) refuses to start the process at all, with a clear
  Zod error naming the missing variable — never a provider that silently
  no-ops or crashes on the first real request.

## Security boundaries

- **No secret ever reaches the client.** Every adapter and every secret
  env var lives under `src/server/` or `src/lib/env.ts`; none is imported
  by a Client Component.
- **No secret is ever logged.** `recordProviderTelemetry`
  (`src/server/providers/telemetry.ts`) has a fixed shape —
  `{category, provider, operation, result, durationMs, errorCode?,
  requestId?, organizationId?}` — with no field a credential, prompt, or
  message body could occupy. Every adapter's own error construction is
  independently tested to never leak a secret even when a mocked vendor
  response body contains something secret-shaped (`openrouter.test.ts`,
  `mistral.test.ts`, `telegram.test.ts`).
- **Settings → Readiness (OWNER-only, Phase 11.4) never returns a
  credential** — only booleans and short labels ("Configured" / "Not
  configured"), built on `getProviderRegistrySnapshot()` and
  `getOrganizationEntitlements()`, neither of which can return a secret
  value by construction (`registry.test.ts` asserts this structurally).
- **Human approval remains authoritative.** A real email is only ever
  sent through `sendCommunication`, which requires an `ActionProposal` to
  already be `APPROVED` before a draft can even be prepared
  (`prepareReminderCommunication`), and re-checks collections-automation
  plan entitlement immediately before every automation-triggered send
  (`isAutoSendStillAuthorized`, `src/server/collections/engine.ts`). No
  code path in this phase — or any prior phase — bypasses that gate.
- **Duplicate-send protection is a compare-and-swap on `Communication.status`**
  (`DRAFT`/`FAILED` → `SENDING`, atomic), not an application-level lock —
  see `docs/communications.md#delivery-semantics`. This phase did not
  need a new idempotency mechanism or a schema change: the existing one
  already covers a double-click, a concurrent retry, and a process crash
  mid-send (recovered via `reconcileStaleSendingCommunication`).

## Known limitations

- **Email is plain-text only.** `EmailMessage`/`Communication.body` carry
  a single plain-text field — no HTML variant. This is a deliberate
  existing design choice (avoids needing an HTML-sanitization boundary
  for AI-and-human-edited content going into a customer's inbox), not an
  oversight of this phase. Adding HTML support would mean a
  `Communication` schema change (a new column) and a sanitization layer —
  out of proportion for a phase scoped to provider infrastructure. Left
  as an explicit decision for a future phase if a real customer need
  arises (see the final report's "decisions before the next phase").
- **GigaChat/Yandex AI and Stripe/YooKassa remain recognized, not
  implemented** — unchanged by this phase; see
  `docs/integration-architecture.md` for why (OAuth/mTLS flows and SDK/
  webhook infrastructure this project cannot build and test correctly
  without a real account).
- **No live health probe.** Readiness/provider-registry status is
  configuration-derived only (env vars passed boot-time validation) —
  never a real network call to the vendor. A vendor that's configured but
  currently down (e.g. an expired API key rejected only at call time)
  still reports "Configured"/"Ready" until an actual send/generation is
  attempted. This is an intentional, documented tradeoff (a "health
  check" that spends real AI budget or sends a real email would be a side
  effect, not a safe check) — see
  `docs/integration-architecture.md#health-model`.
- **Microsoft 365 OAuth2 (Graph API) is not supported** — tenants that
  have disabled legacy SMTP AUTH need a genuinely different adapter,
  documented as future work, not built speculatively.
