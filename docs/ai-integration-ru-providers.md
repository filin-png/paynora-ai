# AI Integration — GigaChat and YandexGPT (Russian AI providers phase)

This documents the phase that gave `AI_PROVIDER=gigachat` and
`AI_PROVIDER=yandex` real adapters, closing a gap `docs/ai-architecture.md`
and `docs/integration-architecture.md#ai-routing` had documented since
Phase 6: both vendors were recognized (selectable, listed in the provider
registry) but resolved to a typed "not implemented yet" error. It does not
replace [docs/ai-architecture.md](./ai-architecture.md) (the Gateway/
interface contract) or [docs/ai-integration.md](./ai-integration.md) (the
Mistral-specific equivalent, written in Phase 21A) — it is the focused,
production-setup-oriented companion for these two vendors specifically,
following the same structure.

**Naming note**: the phase brief that requested this work called the
second provider "YandexGPT" and suggested `AI_PROVIDER=yandexgpt`. This
codebase's `AI_PROVIDER` enum has included `"yandex"` since Phase 6
(`src/lib/env.ts`), already reserved for exactly this vendor. Renaming an
existing, already-documented enum value has a real cost (every existing
reference in code, tests, and docs) for zero functional gain, so `"yandex"`
was kept — it selects the YandexGPT adapter (`src/server/ai/providers/yandexgpt.ts`).
This is called out explicitly wherever the value appears, so it is never
mistaken for a leftover or a different vendor.

## What this phase actually changed

1. Two new real adapters: `src/server/ai/providers/gigachat.ts` and
   `yandexgpt.ts`, implementing the existing `AIProvider` interface —
   nothing about the interface itself changed (see "Architecture" below).
2. `src/server/ai/service.ts#resolveProviderByName`: the `"gigachat"`/
   `"yandex"` cases now return the real adapters instead of throwing
   `AIProviderError("not implemented yet")`.
3. `src/lib/env.ts`: six new environment variables (`GIGACHAT_API_KEY`,
   `GIGACHAT_MODEL`, `GIGACHAT_SCOPE`, `YANDEXGPT_API_KEY`,
   `YANDEXGPT_MODEL`, `YANDEXGPT_FOLDER_ID`) and matching cross-field
   validation — required only once their provider is actually selected
   (as `AI_PROVIDER` or `AI_PROVIDER_FALLBACK`), never proactively, the
   same discipline every other provider in this schema already follows.
4. `src/server/providers/registry.ts`: `gigachat`/`yandex` flipped from
   `implemented: false` to `true`, capabilities updated to
   `["structured-generation"]` (matching OpenRouter/Mistral) — this is
   what makes Settings → Integrations (Phase 8's UI, unchanged) stop
   showing "not implemented yet" next to either vendor.
5. `scripts/live-smoke-test.ts`: `npm run smoke -- ai gigachat --confirm`
   and `npm run smoke -- ai yandex --confirm`, extending the existing
   dev-only manual smoke-test CLI (Phase 8) rather than building a second
   one.
6. Test coverage: `gigachat.test.ts`, `yandexgpt.test.ts` (new), plus
   updates to `service.test.ts`/`registry.test.ts`/`env.test.ts` where
   assertions depended on the old "not implemented" behavior.
7. This document, plus cross-references from `docs/ai-architecture.md` and
   `docs/integration-architecture.md#ai-routing`.

**Nothing else changed.** Tenant isolation, billing/entitlements, the AI
Gateway itself (`src/server/ai/gateway.ts`), the OpenRouter/Mistral
adapters, and every AI call site (`operator/ai-context.ts`,
`copilot/ai-context.ts`, `communications/ai-context.ts`,
`websearch/decision.ts`) are untouched — they only ever see the
vendor-neutral `AIProvider`/`AIRequest`/`AIResult` contract and have no
idea which of the four vendors they're actually talking to.

## Architecture (unchanged shape — two more vendors plug into the existing contract)

```
AI business caller (Operator / Copilot / Communications / WebSearch decision)
        ↓
AI Service        (src/server/ai/service.ts#tryGenerateStructured — resolves provider, bounded fallback, never throws)
        ↓
AI Gateway        (src/server/ai/gateway.ts#runAIGeneration — timeout + AbortController, Zod validation, telemetry)
        ↓
AIProvider        (src/server/ai/providers/{gigachat,yandexgpt}.ts — implement the same interface every vendor implements)
        ↓
GigaChat API       (https://api.giga.chat/v1/chat/completions, via an OAuth token from https://ngw.devices.sberbank.ru:9443/api/v2/oauth)
YandexGPT API      (https://llm.api.cloud.yandex.net/foundationModels/v1/completion)
```

No second AI Gateway, no second quota system, no second telemetry system,
no second retry/timeout policy, and no GigaChat/YandexGPT-specific type
anywhere outside their own two adapter files — exactly the same discipline
Phase 21A's Mistral integration documented, applied to two more vendors.

### Why GigaChat reuses the OpenAI-compatible wire helper and YandexGPT doesn't

`src/server/ai/providers/openai-compatible-chat.ts` is shared by
OpenRouter, Mistral, **and now GigaChat** because GigaChat's
`/chat/completions` endpoint is genuinely OpenAI-compatible for this
codebase's purposes — same `messages`/`response_format: json_object`
request shape, same `choices[0].message.content`/`usage` response shape
(confirmed: Sber's own "Совместимость с OpenAI" guide documents standard
OpenAI JSON-mode/function-calling/streaming as working through this
compatibility layer). The only thing GigaChat's adapter does before
delegating to that shared helper is turn `GIGACHAT_API_KEY` into a
short-lived access token (see "Authentication" below) — the *wire
contract* for the actual completion call is identical to Mistral's.

YandexGPT's Foundation Models API is a different contract entirely:
`role`/`text` messages instead of `role`/`content`, a
`result.alternatives[].message` response envelope instead of `choices[]`,
and integer fields (`completionOptions.maxTokens`, token-usage counts)
serialized as JSON strings rather than numbers — a real Yandex Cloud API
convention, not a bug. `yandexgpt.ts` is a standalone adapter for this
reason — sharing `openai-compatible-chat.ts` would mean bending a
genuinely different wire contract to fit, exactly what that file's own
doc comment says not to do.

## Authentication

### GigaChat: OAuth token exchange, not a static bearer key

Unlike every other AI adapter in this codebase, `GIGACHAT_API_KEY` is
**not** sent directly as a bearer credential to the completions endpoint.
It is the "Authorization key" from the GigaChat personal cabinet — an
already base64-encoded `client_id:client_secret` pair — sent as
`Authorization: Basic <key>` to `POST /api/v2/oauth`
(`https://ngw.devices.sberbank.ru:9443/api/v2/oauth`) along with a
required `RqUID` header (a fresh UUIDv4 per request, via Node's
`crypto.randomUUID()`) and a `scope` form field (`GIGACHAT_SCOPE`,
defaulting to `GIGACHAT_API_PERS` for an individual-developer contract).
The response's `access_token` is what actually authenticates the
`/chat/completions` call, as a normal `Authorization: Bearer` header.

**Token caching, and why it's a closure variable, not module state**:
GigaChat's documented token lifetime is 30 minutes. `gigachat.ts` caches
the token *inside* `createGigaChatProvider`'s closure — the exported
singleton `gigachatProvider` therefore reuses one token across many
production calls instead of re-authenticating every single time, while
each test's own `createGigaChatProvider(fetchImpl)` call gets a fully
independent, empty cache (see `gigachat.test.ts`'s "does not share a
cached token between two independently constructed providers"). This is
the same test-isolation shape every other DI-injectable adapter in this
codebase already uses (`fetchImpl` as a constructor parameter) — the token
cache is just one more piece of per-instance state alongside it, not a new
pattern.

**Why the cache doesn't trust the response's own `expires_at` field**:
public documentation and third-party SDKs disagree on whether that field
is a Unix timestamp in seconds or milliseconds. Getting that wrong in
either direction either discards a still-valid token constantly (seconds
misread as milliseconds → treated as already expired) or uses one past its
real expiry (milliseconds misread as seconds → treated as valid for
~1000× too long). The adapter instead tracks its own conservative,
internally-defined expiry — 30 minutes from the moment it received the
token, minus a 5-minute safety margin — which is correct regardless of
that ambiguity, at the cost of one token exchange every ~25 minutes of
sustained use rather than exactly every 30. This is a deliberate,
documented tradeoff, not an oversight.

### YandexGPT: static API key, not an IAM token

Yandex Cloud documents two auth schemes for this API: a short-lived IAM
token (recommended by Yandex for its security properties, but requiring
either an interactive `yc` CLI session or a service-account JWT-signing
flow to obtain) and a static, non-expiring API key — which Yandex's own
documentation offers explicitly as the simpler alternative "if you can't
automatically request an IAM token." This codebase uses the static key
(`YANDEXGPT_API_KEY`, sent as `Authorization: Api-Key <key>`) because
every other provider here already authenticates with one long-lived
server-side secret, and building a JWT-signing/token-refresh flow for only
this one vendor would be exactly the kind of provider-specific complexity
the phase brief asked not to introduce speculatively.

`YANDEXGPT_FOLDER_ID` is a third required variable beyond the two the
phase brief anticipated (`YANDEXGPT_API_KEY`/`YANDEXGPT_MODEL`) — Yandex
Cloud's completion endpoint has no way to resolve which model to call
without it; it is embedded directly in every request's `modelUri`
(`gpt://<folder>/<model>`) and also sent as the `x-folder-id` header
(matching Yandex's own documented request shape). This is a real,
necessary variable, not scope creep — see `src/lib/env.ts`'s comment on
why it was added.

## Environment configuration

```
AI_PROVIDER=gigachat
GIGACHAT_API_KEY=               # the "Authorization key" from https://developers.sber.ru/studio/workspaces
GIGACHAT_MODEL=GigaChat         # or GigaChat-Pro/GigaChat-Max — verify current names before deploying
GIGACHAT_SCOPE=GIGACHAT_API_PERS  # optional — GIGACHAT_API_B2B/GIGACHAT_API_CORP for a business contract
```

```
AI_PROVIDER=yandex
YANDEXGPT_API_KEY=              # a static Yandex Cloud API key (IAM > Service accounts > API keys)
YANDEXGPT_FOLDER_ID=            # the Yandex Cloud folder id the call bills against
YANDEXGPT_MODEL=yandexgpt/latest  # the model path segment used in modelUri — verify current names before deploying
```

`AI_PROVIDER_FALLBACK` may optionally be set to any of the other three
real vendor names for a single bounded fallback attempt — unchanged
routing/fallback design, see
`docs/integration-architecture.md#ai-routing`. `src/lib/env.ts`'s existing
cross-field validation refuses to boot with either vendor selected (as
primary or fallback) and its required variables missing.

**Never commit a real `GIGACHAT_API_KEY` or `YANDEXGPT_API_KEY` to git.**
`.env.example` documents every variable with no real value; nothing in
this codebase reads either from anywhere but the environment.

### GigaChat TLS certificate — a real deployment prerequisite, not a code concern {#gigachat-tls-certificate}

GigaChat's TLS endpoints (both the OAuth host and `api.giga.chat`) present
a certificate chain signed by the Russian Ministry of Digital
Development's root CA ("НУЦ Минцифры" / "Russian Trusted Root CA"), which
is not present in Node's (or any standard OS's) default trust store.
Without it, every request to GigaChat fails with a TLS verification error
— `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or similar — before this codebase's
own error classification ever runs. This is **not** mutual TLS/client
certificates (an earlier version of `docs/integration-architecture.md`
described it that way before this phase verified it against current
documentation and corrected it) — it is a server-certificate-trust
problem, the same kind any self-signed or privately-rooted HTTPS endpoint
presents.

The correct fix is operational, not a code change: download the "Russian
Trusted Root CA" certificate (from Gosuslugi or the GigaChat docs portal)
and point Node's own `NODE_EXTRA_CA_CERTS` environment variable at it
before starting the process. This is a standard Node.js mechanism that
every `fetch`/`https` call in the process picks up automatically —
**never** work around this by disabling TLS verification
(`NODE_TLS_REJECT_UNSAFE_CERTS=0` or an `https.Agent({ rejectUnauthorized:
false })`), which would remove certificate validation for every outbound
HTTPS call this process makes, not just GigaChat's. This adapter's own
code needed no change for this — it uses the platform `fetch`, which
respects `NODE_EXTRA_CA_CERTS` globally.

## Model selection

Neither `GIGACHAT_MODEL` nor `YANDEXGPT_MODEL` has a code-level default —
same discipline as `MISTRAL_MODEL`: never hardcode a vendor's model
identifier in business logic, always require explicit configuration,
because a vendor's model catalog changes over time. `.env.example`
documents a reasonable example value for each (`GigaChat`,
`yandexgpt/latest`) and points at each vendor's current model-listing
documentation to verify before a real deploy.

## Verification against each vendor's real API — and this phase's real limitation

Phase 21A's Mistral integration verified its adapter directly against
Mistral's live documentation. **This phase could not do the same for
either vendor**: `developers.sber.ru` and `aistudio.yandex.ru` were both
unreachable from this environment's network egress policy during this
phase (blocked at the proxy level, not a temporary outage). Every wire-
contract detail below was instead corroborated through web search against
multiple independent third-party sources — official SDKs (`ai-forever/
gigachat`, `yandex-cloud/docs`), and Sber/Yandex's own documentation as
quoted or mirrored by those sources — cross-checked for consistency across
sources rather than taken from a single one. This is a real, honestly
weaker form of verification than Phase 21A had for Mistral, and is called
out here rather than glossed over.

| Claim | Confidence |
| --- | --- |
| GigaChat OAuth: `POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth`, `Authorization: Basic <key>`, `RqUID` header (uuid4), `scope` form field, 30-minute token lifetime | High — consistent across the official SDK and multiple independent guides |
| GigaChat completions: `POST https://api.giga.chat/v1/chat/completions`, OpenAI-compatible (`Bearer` token, `response_format: json_object`, `choices[]`, `usage`) | High — Sber's own "Совместимость с OpenAI" guide documents JSON mode working through this layer |
| GigaChat's TLS certificate requiring `NODE_EXTRA_CA_CERTS` (or equivalent) | High — documented directly on Sber's own certificates page, independently confirmed by the official Python SDK's own `ca_bundle_file` configuration option |
| GigaChat's native `response_format: json_schema` structured-output mode | Documented to exist, but described as beta, model-gated, and unable to express `anyOf`/`oneOf`/`allOf` — **deliberately not used**; see "Structured output" below |
| YandexGPT: `POST https://llm.api.cloud.yandex.net/foundationModels/v1/completion`, `modelUri`/`completionOptions`/`messages[].{role,text}` request shape, `result.alternatives[].message`/`result.usage` response shape | High — consistent across the API reference title, multiple independent SDKs (Python, Go), and curl examples |
| YandexGPT `completionOptions.maxTokens` and usage-count fields serialized as JSON strings, not numbers | Medium-high — seen directly in an official curl example, consistent with Yandex Cloud's broader int64-as-string convention, but not independently cross-checked against a second primary source |
| YandexGPT `Authorization: Api-Key <key>` (vs. `Bearer <IAM token>`) both being accepted by this specific endpoint | Medium — Yandex Cloud's IAM documentation describes both schemes as valid across its APIs generally; this phase did not find a same-endpoint example using `Api-Key` specifically, only the general IAM authentication guide and a same-shape example (`Authorization: Api-Key`) against a sibling Yandex Cloud AI endpoint |
| YandexGPT native JSON Schema `responseFormat` field | A snippet claimed this exists but this phase could not confirm its exact shape from a primary source — **not used**; see "Structured output" below |

**What this means concretely**: the wire contract shapes above are
implemented and unit-tested against exactly these assumptions
(`gigachat.test.ts`, `yandexgpt.test.ts`), but — per this document's own
"Production readiness" section below — **no amount of mocked testing
proves a real vendor's live behavior matches these assumptions**. That is
what the manual smoke test (see below) is for, and it has not been run
against either vendor's real API as part of this phase; a real account
was never obtained or used.

## Structured output

Both adapters use the same pattern every existing adapter (OpenRouter,
Mistral) already uses: a system-prompt instruction ("Respond with a
single JSON object only...") plus the vendor's plain JSON-mode field where
one exists (GigaChat: `response_format: {type: "json_object"}`, via the
shared `openai-compatible-chat.ts` helper), followed by `JSON.parse` and
the caller's Zod schema — the same centralized validation in
`src/server/ai/gateway.ts` every provider's output goes through, with no
provider-specific bypass.

**Why neither adapter uses a native strict-JSON-Schema mode**, even though
both vendors document one:

- GigaChat's `response_format: {type: "json_schema", ...}` exists but is
  documented as beta, gated to specific models, and unable to express
  `anyOf`/`oneOf`/`allOf` (which several of PAYNORA's real Zod schemas —
  e.g. discriminated unions — would need). Using it would mean either a
  fragile per-model capability check or a real risk of the request being
  rejected outright depending on which `GIGACHAT_MODEL` is configured.
- YandexGPT's equivalent `responseFormat` field's exact shape could not be
  confirmed against a primary source in this phase (see the table above).

This codebase's own stated principle — "не доверять модели только потому,
что provider обещает schema compliance," and Zod is always the real,
final validation boundary regardless of what a vendor's wire-level mode
promises — means the plain JSON-mode-via-prompt pattern loses nothing in
practice: a malformed or schema-violating response is discarded exactly
the same way whether or not the vendor's own "strict mode" claims to
prevent it. Using the simpler, already-audited pattern that every other
adapter in this codebase already uses is the correct choice here, not a
shortcut — see the phase brief's own closing emphasis on this exact
tradeoff.

## Function/tool calling and streaming

**Not implemented for either vendor — because neither is part of this
codebase's `AIProvider` contract at all**, for any vendor. `src/server/ai/
types.ts#AIProvider` has exactly one method, `generateStructured`; there
is no `callTool`/`generateWithTools` method, and no streaming method,
anywhere in this codebase's AI abstraction — confirmed by direct code
search, not assumption (`grep -rn "tool_calls\|function_call\|streaming"
src/server/ai/` returns nothing outside this phase's own new doc
comments). This is not a per-vendor capability gap to work around; it is
this codebase's own architecture, unchanged by this phase and out of this
phase's scope to extend. If a future phase adds tool-calling or streaming
to the `AIProvider` contract, GigaChat and YandexGPT would need their own
translation of that capability then — not invented speculatively now.

## Retry policy and timeout (unchanged — the same one Gateway-owned policy every vendor uses)

Neither adapter implements same-provider retry or its own timeout — the
existing, deliberately narrow policy documented in
`docs/integration-architecture.md#ai-routing` and `docs/ai-integration.md`
applies identically: `src/server/ai/gateway.ts#runAIGeneration` owns the
only timeout (10s default) and the only `AbortController`, whose `signal`
both new adapters forward into every `fetch` call they make — including
GigaChat's OAuth exchange, since it happens inside the same
`generateStructured` call the Gateway's timeout budget covers. The only
"retry" that exists is `AI_PROVIDER_FALLBACK`: at most one attempt against
a **different** vendor with a **different** credential.

## Cost control

Both vendors are subject to the same two independent layers Phase 21A
documented for Mistral, with zero vendor-specific carve-out:

1. **AI generation quota** (`checkAiGenerationQuota`, per-organization,
   per-plan, monthly) — checked before any call site invokes
   `tryGenerateStructured`, regardless of which `AI_PROVIDER` is
   configured.
2. **Output-size bound** (`AIRequest.maxOutputTokens`) — forwarded to
   GigaChat's wire-level `max_tokens` (via the shared OpenAI-compatible
   helper) and YandexGPT's `completionOptions.maxTokens` (serialized as a
   string, per that API's own convention) identically to how Mistral
   already receives it. No call site needed to change — every real
   `AIRequest` builder already sets this field (Phase 21A's own cost-
   control fix), and it now reaches whichever of the four vendors is
   actually configured.

## Errors (unchanged normalized contract)

Every GigaChat/YandexGPT-specific failure (bad authorization key, OAuth
failure, rate limit, network error, malformed response) is normalized
into a plain `Error` with a message containing only an HTTP status code
and its classification bucket (`"authentication failed"` for 401/403,
`"rate limited"` for 429, `"provider error"` for ≥500, `"request
rejected"` otherwise) — the same buckets `openai-compatible-chat.ts`
already uses for OpenRouter/Mistral, applied to both new adapters (Yandex
directly; GigaChat both for its own OAuth step and, via the shared helper,
for its completions call). `src/server/ai/service.ts#tryGenerateStructured`
catches this the same as any other `AIProvider` failure and returns `null`
if every configured attempt fails — no user-facing "AI unavailable" error
message exists to design, same as every other vendor.

## Secret redaction — verified, not assumed

- **GigaChat**: `GIGACHAT_API_KEY` (the Basic-auth "Authorization key")
  never appears in a thrown error from the OAuth step — confirmed by
  `gigachat.test.ts`'s dedicated tests on 401 and on a raw network
  failure. The derived access token likewise never appears in a thrown
  error from the completions step — confirmed by the same suite (a
  distinct test using a different, obviously-fake "super-secret-access-
  token" value to make a leak unmistakable if one existed).
- **YandexGPT**: `YANDEXGPT_API_KEY` never appears in a thrown error —
  confirmed by `yandexgpt.test.ts`'s equivalent tests on 401 and on a raw
  network failure.
- **Telemetry**: both adapters' calls go through the same
  `recordProviderTelemetry` choke point every AI call already uses
  (`src/server/ai/gateway.ts`) — its event shape structurally has no field
  for a prompt, response, or credential, unchanged by this phase.
- **Logs**: `src/server/ai/service.ts#logAIFailure` logs only an error's
  `name`/`message` for whichever vendor failed, never `request` — the
  same discipline already covering OpenRouter/Mistral now covers both new
  vendors without any vendor-specific branch.

## Testing without a real GigaChat or Yandex Cloud account

`gigachat.test.ts` and `yandexgpt.test.ts` use an injectable `fetchImpl`
(default: the real global `fetch`) — every test mocks the network
boundary, never makes a real call. Coverage for each: missing
configuration, a full successful request/response round-trip (URL,
headers, body shape, `usage` mapping), HTTP 400/401/403/429/5xx
classification with secret redaction, a malformed response body, invalid
JSON in the response content, a real network failure (a rejected `fetch`
promise), `maxOutputTokens` forwarding, and concurrent calls resolving
independently. `gigachat.test.ts` additionally covers: the OAuth
exchange's own request shape, token caching across two calls (proving the
second call doesn't re-authenticate), and cache isolation between two
independently constructed provider instances.

Zod-validation-failure and Gateway-level timeout behavior are **not**
duplicated per adapter — consistent with how `mistral.test.ts`/
`openrouter.test.ts` already handle this, that behavior is provider-
agnostic and already exercised once, centrally, in `gateway.test.ts`.
`AI_PROVIDER` is unset in `vitest.config.mts`, so CI never depends on —
and never spends — a real GigaChat or Yandex Cloud credential.

## Real API smoke test (manual, dev-only, never in CI)

```
GIGACHAT_API_KEY=... GIGACHAT_MODEL=GigaChat npm run smoke -- ai gigachat --confirm
YANDEXGPT_API_KEY=... YANDEXGPT_FOLDER_ID=... YANDEXGPT_MODEL=yandexgpt/latest npm run smoke -- ai yandex --confirm
```

`scripts/live-smoke-test.ts` (Phase 8, generalized for any AI vendor) now
recognizes both vendor names — no new script was built. It refuses to run
under `CI=true`/`CI=1` or inside the Vitest runner, requires `--confirm`,
and exercises the real chain end-to-end using fixed, synthetic smoke-test
data (`SMOKE-TEST-0001`), never a real customer's. It never prints a
credential, a raw response body, or the system prompt.

**Neither smoke test has been run in this phase** — no real GigaChat or
Yandex Cloud account was obtained or used, per the phase brief's own
explicit instruction not to request or embed real credentials. Running
either is the next concrete step before either vendor can be trusted in
production — see "Production readiness" below.

## What must never enter git

- A real `GIGACHAT_API_KEY` or `YANDEXGPT_API_KEY` value, anywhere — not
  in `.env.example`, not in a commit message, not in a test fixture, not
  in this documentation.
- A real access token obtained from GigaChat's OAuth endpoint.
- A real GigaChat or YandexGPT API response captured from a live
  smoke-test run (may echo back input you passed it).
- Any `.env.local`/`.env` file (already gitignored).

## Production readiness — what is and isn't proven yet

**Implemented and tested without a real credential:**
- Both adapters' request/response wire contracts, built from the best
  verification this phase's network access allowed (see "Verification"
  above and its explicit confidence table — this is weaker evidence than
  Phase 21A had for Mistral, and this document says so plainly rather
  than implying otherwise).
- Error classification, secret redaction, timeout/AbortController wiring,
  Zod validation, quota/rate-limit enforcement, tenant isolation, and
  cost-control (`maxOutputTokens`) — all covered by mocked-network unit
  tests, none of which prove either real vendor actually behaves as
  documented.
- GigaChat's OAuth token exchange and caching logic, including the
  deliberate choice not to trust the response's own `expires_at` field.

**Requires a real credential to actually confirm, and has not been run in
this phase:**
- That `npm run smoke -- ai gigachat --confirm` and
  `npm run smoke -- ai yandex --confirm` actually succeed against each
  real API with a real key/folder id.
- That the recommended example models (`GigaChat`, `yandexgpt/latest`)
  are still the correct current identifiers at deploy time.
- That GigaChat's real endpoints are reachable at all without first
  configuring `NODE_EXTRA_CA_CERTS` — this phase could not test this
  either, since `developers.sber.ru` itself was unreachable from this
  environment.
- That YandexGPT's `Authorization: Api-Key` scheme is genuinely accepted
  by the specific `/foundationModels/v1/completion` endpoint used here
  (medium confidence per the table above, not confirmed against a primary
  source for this exact endpoint).
- Real-world latency/timeout behavior, and each account's real rate-limit
  tier, under real usage.

**This integration must not be described as production-ready** — it means
the code that will run once real credentials are configured has been
built against the most careful verification this phase's network access
allowed and behaves correctly against every mocked failure mode this
phase could construct. Whether either vendor's live behavior actually
matches these assumptions is unconfirmed, and is explicitly flagged here
as unconfirmed rather than glossed over.
