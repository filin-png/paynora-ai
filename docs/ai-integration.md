# AI Integration — Mistral (Phase 21A: real production AI provider)

This documents Phase 21A: making Mistral PAYNORA's real, primary
production AI provider. It does not replace
[docs/ai-architecture.md](./ai-architecture.md) (the Gateway/interface
contract) or
[docs/integration-architecture.md#ai-routing](./integration-architecture.md#ai-routing)
(the full routing/fallback design, written in Phase 6 when both the
OpenRouter and Mistral adapters were first built) — it is the focused,
production-setup-oriented companion to both, and the place this phase's
own findings (research verification, security review, cost-control
hardening) are recorded.

## What Phase 21A actually changed

**The Mistral adapter itself did not need to change.** It already existed
(Phase 6, `src/server/ai/providers/mistral.ts`) as a real HTTP adapter
against Mistral's own `/chat/completions` endpoint, built on the same
shared OpenAI-compatible wire helper OpenRouter uses
(`src/server/ai/providers/openai-compatible-chat.ts`). Phase 21A's audit
verified every part of it against Mistral's current official
documentation (see "Verification" below) and found it already correct:
right endpoint, right auth scheme, right JSON-mode parameter, right error
codes, right `max_tokens` parameter name. Nothing in the adapter's wire
logic was invented or guessed.

What this phase actually did:

1. Verified the existing implementation against Mistral's real, current
   API documentation (not assumed) — see "Verification" below.
2. Closed a real cost-control gap: `AIRequest.maxOutputTokens` existed in
   the type and was already wired through to the wire-level `max_tokens`
   parameter, but no caller ever set it — see "Cost control" below.
3. Added test coverage for gaps the existing `mistral.test.ts` didn't
   cover: HTTP 429, HTTP 5xx, HTTP 403, a real network failure, and
   concurrent calls.
4. Ran a dedicated security review (see "Security review" below).
5. Updated `.env.example` and this documentation with a verified,
   currently-supported recommended model identifier.

## Architecture (unchanged — Mistral plugs into the existing contract)

```
AI business caller (Operator / Copilot / Communications / WebSearch decision)
        ↓
AI Service        (src/server/ai/service.ts#tryGenerateStructured — resolves provider, bounded fallback, never throws)
        ↓
AI Gateway        (src/server/ai/gateway.ts#runAIGeneration — timeout + AbortController, Zod validation, telemetry)
        ↓
AIProvider        (src/server/ai/providers/mistral.ts — implements the same interface every vendor implements)
        ↓
Mistral API       (https://api.mistral.ai/v1/chat/completions)
```

And, orthogonally, the deterministic fallback every caller already has:

```
AI Gateway / AI Service
        ↓ (disabled, misconfigured, timeout, provider error, invalid output — all of these, uniformly)
deterministic fallback (buildDeterministicSummary / buildDeterministicReminderEmail / CopilotAnswer.deterministicAnswer / no-search direct path)
```

No second AI Gateway, no second quota system, no second telemetry system,
and no Mistral-specific type anywhere outside
`src/server/ai/providers/mistral.ts` and `openai-compatible-chat.ts` —
Operator, Copilot, Communications, AR, Wallet, billing, and every UI
component only ever see the vendor-neutral `AIProvider`/`AIRequest`/
`AIResult` contract from `src/server/ai/types.ts`.

## Environment configuration

```
AI_PROVIDER=mistral          # PAYNORA's primary production provider
MISTRAL_API_KEY=             # from https://console.mistral.ai/ — La Plateforme, "API Keys"
MISTRAL_MODEL=mistral-small-latest   # see "Model selection" below — no code-level default, must be set explicitly
```

No `MISTRAL_BASE_URL` variable was added. Mistral's `/chat/completions`
endpoint is a single, stable, documented URL
(`https://api.mistral.ai/v1/chat/completions` — confirmed current as of
this phase); introducing a variable to override it would be configuration
without a real use case (`docs/provider-strategy.md`'s "no adapter/config
before it's needed" rule applies to env vars too). Add one later only if
a genuine need arises (e.g. a private/regional Mistral deployment).

`AI_PROVIDER_FALLBACK` may optionally be set to `openrouter` (or vice
versa) for a single bounded fallback attempt — see
docs/integration-architecture.md#ai-routing. This is unchanged by Phase
21A and not required.

`src/lib/env.ts`'s existing cross-field validation already refuses to
boot with `AI_PROVIDER=mistral` (or `AI_PROVIDER_FALLBACK=mistral`) and no
`MISTRAL_API_KEY`/`MISTRAL_MODEL` — this was already true before Phase
21A and required no change.

**Never commit a real `MISTRAL_API_KEY` to git.** `.env.example` documents
the variable with no real value, `.env.local`/`.env` are gitignored (see
`.gitignore`), and nothing in this codebase reads `MISTRAL_API_KEY` from
anywhere but the environment.

## Model selection

`MISTRAL_MODEL` is required configuration, never hardcoded in business
logic or in the adapter itself (`src/server/ai/providers/mistral.ts`
reads `env.MISTRAL_MODEL` at call time and throws a clear configuration
error if it's unset — see `service.ts`'s `resolveProviderByName` doc
comment for why this is a deliberate discipline, not an oversight).

Per Mistral's own model-picking documentation, **`mistral-small-latest`**
is the recommended choice for this codebase's actual AI-assisted tasks —
short reminder-email wording, one-paragraph insight summaries, and
Copilot explanations that must not invent facts. None of these are heavy
reasoning, code-generation, or agentic tasks, which is where Mistral
recommends its larger models (`mistral-large-latest`,
`mistral-medium-latest`). `mistral-small-latest` is documented in
`.env.example` as the recommended example value — not a code-level
default, since a vendor's own model catalog and recommended aliases can
change, and this codebase's discipline is "never hardcode a vendor model,
always require explicit configuration."

**Verify current model names before a real production deploy** at
<https://docs.mistral.ai/getting-started/models/> — Mistral's model
lineup moved quickly in late 2025/early 2026 (Large 3, Small 4, and the
Ministral 3 edge family all shipped within that window), so a model id
that was current when this document was written may have a newer
successor by the time you configure this.

## Verification against Mistral's real API (this phase's research, not assumptions)

Confirmed against Mistral's own current documentation:

| Claim | Status |
| --- | --- |
| Endpoint `POST https://api.mistral.ai/v1/chat/completions` | Confirmed current |
| `response_format: {"type": "json_object"}` forces JSON-only output | Confirmed current — Mistral's docs also recommend instructing the model to output JSON in the prompt itself, which `openai-compatible-chat.ts`'s system-prompt suffix (`"Respond with a single JSON object only..."`) already does |
| Auth: `Authorization: Bearer <API_KEY>`, no other scheme | Confirmed |
| Error codes: 401 (bad credentials), 403 (guardrail/moderation block), 429 (rate limit), 500/502/503/504 (transient server errors) | Confirmed — `openai-compatible-chat.ts`'s existing classification (401/403 → "authentication failed", 429 → "rate limited", ≥500 → "provider error") already covers exactly this set correctly |
| `max_tokens` (exact OpenAI-compatible name) bounds output length | Confirmed — already wired from `AIRequest.maxOutputTokens` |
| Recommended model for short-form summarization/email-writing tasks | `mistral-small-latest`, per Mistral's own model-picking guide |

No provider code needed to change as a result of this verification — the
Phase 6 implementation was already correct on every point above.

## Retry policy (unchanged, deliberately narrow)

Mistral's own docs recommend exponential backoff for 429/5xx — this
codebase does **not** implement same-provider retry for any AI call, by
design (`docs/integration-architecture.md#ai-routing`'s "retryable vs.
non-retryable, explicitly" section). The only "retry" that exists is
`AI_PROVIDER_FALLBACK`: at most one attempt against a **different**
vendor with a **different** credential, never a second attempt against
Mistral itself. This is a deliberate, bounded policy — an unbounded or
same-provider retry loop against a paid, rate-limited API is exactly the
"potentially costly AI request repeated automatically" this phase's brief
explicitly forbids.

## Timeout (unchanged — one Gateway-owned timeout, not two)

`src/server/ai/gateway.ts#runAIGeneration` owns the only timeout
(`DEFAULT_TIMEOUT_MS = 10_000`, overridable per call) and creates one
`AbortController` per attempt, whose `signal` every real HTTP adapter
(Mistral included) forwards straight into its own `fetch` call. The
Mistral adapter does not implement — and must not implement — a second,
independent timeout; doing so would let a provider-level timer fire
before or after the Gateway's own, defeating the "one real, enforced
timeout, not a client-side race" guarantee `docs/integration-architecture.md#ai-routing`
already documents.

## Cost control

Two independent layers, both real:

1. **AI generation quota** (`src/server/billing/entitlements.ts#checkAiGenerationQuota`)
   — a per-organization, per-plan monthly ceiling, checked *before* any
   AI call site invokes `tryGenerateStructured`. Unchanged by this phase.
2. **Output-size bound** (`AIRequest.maxOutputTokens`) — Phase 21A closed
   a real gap here: the field existed and was already forwarded to the
   wire-level `max_tokens` parameter (`openai-compatible-chat.ts`), but no
   real call site ever set it, so output length was previously bounded
   only by the model's own completion behavior. Every real `AIRequest`
   builder now sets it, sized generously above that feature's own Zod
   schema ceiling (never so tight that a legitimate response gets
   truncated into invalid JSON) but genuinely bounded (never so loose
   that a runaway/malformed generation costs unboundedly more than
   expected):

   | Caller | Schema ceiling | `maxOutputTokens` |
   | --- | --- | --- |
   | Operator insight (`operator/ai-context.ts`) | 500-char summary | 500 |
   | Copilot explanation (`copilot/ai-context.ts`) | 800-char explanation | 700 |
   | Reminder email (`communications/ai-context.ts`) | 200-char subject + 10,000-char body *safety ceiling* (a real short email runs far shorter) | 2000 |
   | Web-search decision (`websearch/decision.ts`) | 2000-char direct answer | 1200 |

   A response actually truncated by this limit fails JSON parsing or Zod
   validation the same way any other malformed output does
   (`src/server/ai/gateway.ts`) — discarded, never partially trusted, the
   caller's deterministic fallback runs. This is an accepted tradeoff:
   the alternative (loose enough to never truncate anything) reintroduces
   the unbounded-cost exposure this control exists to close.

**Input size** was audited, not newly bounded — every real `AIRequest`'s
`input` is already a small, pre-computed, structurally bounded object (one
invoice's facts, one customer's summary, a fixed list already capped
elsewhere — e.g. `MAX_ATTENTION_ITEMS` in `src/server/briefing/daily-brief.ts`),
never a raw, unbounded database query result. There was no genuine
unbounded-input risk to close here.

## AI quota, rate limiting, and tenant isolation (unchanged, reused as-is)

- **Quota** (plan-level, monthly): `checkAiGenerationQuota` — see above.
- **Rate limit** (abuse guard, hourly): `checkRateLimit("ai:generation", organizationId, aiGenerationPolicy())` —
  a distinct, faster-acting check than the monthly quota, checked
  alongside it at every real call site (`src/server/copilot/service.ts`,
  `src/server/communications/draft.ts`, `src/server/operator/insights.ts`).
- **Tenant isolation**: every real AI call site derives `organizationId`
  from a server-side, session-authenticated membership check
  (`requireOrganizationMembershipForPage`/`requireOrganizationRoleForPage`)
  before any AI/quota code runs — never from client-supplied input a
  request body could manipulate. See "Security review" below for the
  concrete trace.

Phase 21A did not touch any of this — the existing quota/rate-limit
architecture already applies uniformly to whichever provider
`AI_PROVIDER` resolves to, Mistral included, with no Mistral-specific
carve-out or second quota system.

## Errors (unchanged normalized contract)

Every Mistral-specific failure (bad key, rate limit, network error,
malformed response) is normalized into one of the four existing
`src/server/ai/errors.ts` classes before any caller sees it —
`AIDisabledError`, `AITimeoutError`, `AIProviderError`, `AIValidationError`
— never a raw fetch error, vendor response body, or stack trace. None of
these ever reaches an end user directly: `tryGenerateStructured` catches
all of them and returns `null`, and every real caller already has a
deterministic fallback path for that (`CopilotAnswer.deterministicAnswer`,
`buildDeterministicSummary`, `buildDeterministicReminderEmail`). There is
no user-facing "AI unavailable" error message to design, because the
product experience for "AI unavailable" is simply the deterministic
answer/summary/email PAYNORA always had — see
[docs/ai-architecture.md#failure-handling](./ai-architecture.md#failure-handling).

## Telemetry (unchanged, already secret-free by construction)

`src/server/providers/telemetry.ts#recordProviderTelemetry` is the single
choke point every AI call goes through (from inside
`runAIGeneration`, regardless of which provider). Its event shape
(`category`, `provider`, `operation`, `result`, `durationMs`, `errorCode`,
`requestId?`, `organizationId?`) structurally cannot carry a prompt, a
response, or a credential — there is no field for one. `gateway.test.ts`'s
telemetry suite proves this concretely: a provider error containing a
fake secret token, and a request containing fake PII, are both run
through the real telemetry path and asserted to never appear in the
logged line.

## Security review

Reviewed against the phase brief's 15-point list. Findings:

1. **Cross-tenant data leakage** — not possible. Every `AIRequest.input`
   is built by a caller that already scoped its own data lookup by
   `organizationId` (e.g. `getCustomer`/`getActionProposal` throw
   `*ResourceNotFoundError` for a cross-tenant id, the same enumeration-safe
   pattern used everywhere else in this codebase) before ever reaching
   `tryGenerateStructured`. Mistral itself never sees an `organizationId`
   or any cross-org identifier at all — only the already-scoped facts.
2. **Prompt injection** — defended structurally, not by wording:
   `AIRequest` always separates fixed `system` instructions from `input`
   business data (never string-concatenated); every system prompt
   explicitly instructs the model to treat `input` as data, not
   instructions, even if it looks like a command. See
   `src/server/*/ai-context.test.ts` for concrete adversarial-input tests
   per caller.
3. **Secrets leakage** — audited: none of the four `AIRequest` builders
   (`operator/ai-context.ts`, `copilot/ai-context.ts`,
   `communications/ai-context.ts`, `websearch/decision.ts`) reference any
   secret, key, or credential — confirmed by direct code search, not
   inference.
4. **API key leakage** — `MISTRAL_API_KEY` is read once, lazily, from
   `env` inside the adapter; never logged (telemetry structurally can't
   carry it), never returned to a client, never included in an error
   message (`openai-compatible-chat.ts`'s error path includes only the
   HTTP status code, confirmed by `mistral.test.ts`'s dedicated
   secret-redaction tests on 401/403/429/5xx).
5. **System prompt leakage** — every system prompt explicitly instructs
   the model to refuse to reveal its instructions if asked; more
   fundamentally, the model's raw text response is never shown to a user
   unfiltered — only the Zod-validated structured field (e.g.
   `explanation`, `summary`) reaches the UI, and none of those schemas
   have a field that could carry a leaked system prompt without also
   failing its own length/shape constraints in an obviously broken way.
6. **Excessive data sent to Mistral** — audited: every real caller's
   `input` is a small, pre-computed fact set (one invoice, one customer
   summary, a capped attention-item list), never a raw table dump.
7. **Unauthorized AI invocation** — confirmed no Next.js route or Server
   Action calls `tryGenerateStructured`/`runAIGeneration` directly;
   every path goes through a domain function
   (`answerCopilotQuestion`/`prepareReminderCommunication`/
   `runOperator`) that itself requires an authenticated, tenant-scoped
   context first.
8. **Direct client attempt to invoke the provider** — there is no
   API route that accepts a client-supplied `system`/`input`/`schema`;
   the four `AIRequest` shapes are fixed, server-authored constants,
   never client-constructed.
9. **Manipulation of `organizationId`** — every real call site derives it
   from `requireOrganizationMembershipForPage(orgSlug)`/
   `requireOrganizationRoleForPage(orgSlug, role)` — a server-side,
   session-authenticated lookup — never from a client-supplied field
   trusted directly. Traced concretely for the two currently
   UI-reachable AI paths: `src/app/app/[orgSlug]/actions/actions.ts`
   (Operator run) and `src/app/app/[orgSlug]/actions/[proposalId]/actions.ts`
   (Communications draft).
10. **Manipulation of plan/quota** — `checkAiGenerationQuota` reads the
    organization's real, server-side entitlements
    (`getOrganizationEntitlements`); nothing about a plan/quota check is
    client-influenced.
11. **AI quota bypass** — every real AI call site (`copilot/service.ts`,
    `communications/draft.ts`, `operator/insights.ts`) calls
    `checkAiGenerationQuota` before `tryGenerateStructured`; there is no
    AI call site that skips it.
12. **Rate-limit bypass** — same discipline, via `checkRateLimit("ai:generation", ...)`
    at the same call sites, independent of and in addition to the quota
    check.
13. **Invalid structured output** — every response is Zod-validated
    centrally in `runAIGeneration` before any caller sees it; a response
    that fails validation is discarded (`AIValidationError`), never
    partially trusted.
14. **Provider error leakage** — see "API key leakage" above; the same
    discipline covers any provider error detail, not just the key.
15. **Logging of sensitive financial data** — `recordProviderTelemetry`'s
    event shape has no field for request/response content (see
    "Telemetry" above); `logAIFailure` in `service.ts` logs only an
    error's `name`/`message`, never `request`.

**No blocking issues found.** One real, actionable gap was found and
fixed: the missing `maxOutputTokens` cost-control bound (see "Cost
control" above) — informational/hardening, not a vulnerability, since the
existing per-organization quota already bounds total *request* volume;
this closes the remaining *per-request* cost exposure.

**One scope note, not a security finding**: Phase 16's Proactive Copilot
(`answerCopilotQuestion`) and Phase 14's web-search decision step
(`buildWebSearchDecisionRequest`/`tryWebSearch`) are both fully
implemented, tested domain logic — but neither is currently wired to any
UI or Server Action (confirmed by code search: no file under `src/app`
imports either). This means that, as of this phase, real Mistral traffic
in production only actually flows through two live, UI-triggered paths:
Operator insight generation and Communications reminder-email drafting
(both reachable from Settings → Action Center). This is an existing gap
from earlier phases, not something Phase 21A introduced or was asked to
close (per the brief's own "don't build new UI just for this phase, don't
add features just to pad scope" constraint) — recorded here so it's not
mistaken for something this phase silently broke.

## Structured output pipeline (unchanged)

```
AIRequest (system + input + schema)
  → Mistral (POST /chat/completions, response_format: json_object)
  → raw string content
  → JSON.parse (throws AIProviderError-wrapped on malformed JSON)
  → request.schema.safeParse (src/server/ai/gateway.ts)
  → success: normalized AIResult<T> returned to caller
  → failure: AIValidationError, discarded, caller's deterministic fallback runs
```

Mistral's response is never treated as trusted merely because it came
from the model — the same centralized Zod check every other provider's
output goes through applies identically here, with no Mistral-specific
bypass or shortcut.

## Testing without a real Mistral account

`src/server/ai/providers/mistral.test.ts` uses an injectable `fetchImpl`
(default: the real global `fetch`) — every test mocks the network
boundary, never makes a real call. As of Phase 21A it covers: missing
configuration, a full successful request/response round-trip (URL,
headers, body shape, `max_tokens` forwarding, usage mapping), HTTP
401/403/429/5xx classification with secret redaction, a malformed
response body, a real network failure (a rejected `fetch` promise), and
concurrent calls resolving independently. Generic Gateway-level behavior
(timeout, Zod rejection, routing/fallback) is exercised once,
provider-agnostically, in `gateway.test.ts`/`service.test.ts` — not
duplicated per vendor. `AI_PROVIDER` is unset in `vitest.config.mts`, so
CI never depends on — and never spends — a real Mistral credential.

## Real API smoke test (manual, dev-only, never in CI)

```
MISTRAL_API_KEY=... MISTRAL_MODEL=mistral-small-latest npm run smoke -- ai mistral --confirm
```

`scripts/live-smoke-test.ts` already supported this exact command before
Phase 21A (built in Phase 8, generalized for any AI vendor). It refuses to
run under `CI=true`/`CI=1` or inside the Vitest runner, requires
`--confirm`, and exercises the real chain end-to-end — PAYNORA → AI
Gateway → Mistral → structured result → PAYNORA's real Zod validation
(via the same `buildReminderEmailRequest`/`runAIGeneration` production
call shape) → a printed, schema-validated result — using fixed, synthetic
smoke-test data (`SMOKE-TEST-0001`), never a real customer's. It never
prints the API key, a raw response body, or the system prompt. No code
change was needed here; it already supported Mistral.

## What must never enter git

- A real `MISTRAL_API_KEY` value, anywhere — not in `.env.example`, not
  in a commit message, not in a test fixture, not in this documentation.
- A real Mistral API response captured from a live smoke-test run (may
  echo back input you passed it).
- Any `.env.local`/`.env` file (already gitignored).

## Production readiness — what is and isn't proven yet

**Implemented and tested without a real credential:**
- The Mistral adapter's request/response wire contract, verified against
  Mistral's current official documentation (this phase).
- Error classification, secret redaction, timeout/AbortController wiring,
  Zod validation, quota/rate-limit enforcement, tenant isolation, and
  cost-control (`maxOutputTokens`) — all covered by mocked-network unit
  tests, none of which prove the real vendor actually behaves as
  documented.

**Requires a real `MISTRAL_API_KEY` to actually confirm, and has not been
run in this phase** (per the brief: the founder sets up the real key
separately):
- That `npm run smoke -- ai mistral --confirm` actually succeeds against
  the real Mistral API with a real key.
- That the recommended `mistral-small-latest` model is still the correct
  current alias at deploy time (verify at
  <https://docs.mistral.ai/getting-started/models/> — Mistral's lineup
  changes over time).
- Real-world latency/timeout behavior against the live API (the 10s
  Gateway timeout has never been exercised against a real Mistral
  response).
- Real rate-limit tier behavior (this account's actual RPS/TPM/monthly
  caps) under real usage.

**Passing unit tests does not mean this is production-ready** — it means
the code that will run once a real key is configured has been verified
against Mistral's documented contract and behaves correctly against every
mocked failure mode this phase could construct. The one thing no amount
of mocked testing can confirm is whether the real vendor's live behavior
still matches its own documentation on the day you deploy — that is what
the smoke test is for, and it has not been run against a real key as part
of this phase.
