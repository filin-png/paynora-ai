# AI Architecture

**Status (updated Phase 21A): the AI Gateway foundation below is
implemented (Phase 3) and unchanged since. Two real vendor adapters exist —
OpenRouter and Mistral (both Phase 6) — with Mistral as PAYNORA's primary
production AI provider (Phase 21A). `AI_PROVIDER=none` remains the
default** (no credentials required to run the app); `gigachat`/`yandex`
are still recognized-but-unimplemented, resolving to a clear
`AIProviderError` rather than a real integration or a silent no-op. See
**[docs/ai-integration.md](./ai-integration.md)** for the Mistral-specific
production setup guide (environment variables, security review, quota,
fallback, smoke test) and
[docs/integration-architecture.md#ai-routing](./integration-architecture.md#ai-routing)
for the full routing/fallback design. This document covers the
interface/Gateway contract itself, which none of that changed.
See [docs/operator-foundation.md](./operator-foundation.md) and
[docs/communications.md](./communications.md#ai-and-email-wording) for two
of the features that use it: Operator insight summaries (Phase 3) and
reminder email wording (Phase 4) — each with its own prompt/schema, both
built on the same unchanged Gateway below. (Phase 16's Proactive Copilot
and Phase 14's web-search decision step also build `AIRequest`s the same
way — see docs/ai-integration.md for the honest status of what's actually
wired to a UI today.)

## Why an abstraction

The initial real AI provider is expected to be GigaChat, because the
project must be developable and testable from Russia without a foreign
card or an OpenAI/Anthropic account, and because it minimizes
infrastructure cost during early development. PAYNORA itself must not
depend on GigaChat directly — the choice of AI vendor is an infrastructure
decision, not a product one, and a sellable asset shouldn't be hard-wired
to a single vendor chosen for the founder's early circumstances.

## Interface (implemented)

```ts
// src/server/ai/types.ts
type AIRequest<T> = {
  system: string;      // fixed, operator-authored instructions — never business data
  input: unknown;       // structured business data, always separate from `system`
  schema: z.ZodType<T>; // validates and types the response
  maxOutputTokens?: number;
};

type AIResult<T> = { data: T; provider: string; usage?: { promptTokens?: number; completionTokens?: number } };

interface AIProvider {
  readonly name: string;
  // `signal` (Phase 8): a real AbortSignal the Gateway aborts on timeout —
  // every real HTTP adapter forwards it to `fetch` so a timed-out request
  // is actually cancelled at the socket level. See "timeouts" below.
  generateStructured<T>(request: AIRequest<T>, options?: { signal?: AbortSignal }): Promise<AIResult<T>>;
}
```

One generic method, not one per feature (`generateReminder`,
`classifyReply`, ...): every AI-assisted feature describes its own
input/output shape with a Zod schema and passes it to
`generateStructured`, so adding a new AI-assisted feature never requires
touching a provider adapter — only a new schema and prompt at the call
site. Phase 4 proved this out: `src/server/communications/ai-context.ts`
(email subject/body) was added alongside
`src/server/operator/ai-context.ts` (insight tone/summary) without either
one, or the Gateway, changing at all. This ended up simpler than the
per-feature interface sketched in earlier drafts of this document, and
covers the same ground.

## The chain: caller → AI Service → AI Gateway → AIProvider

(Operator or Communications — both callers go through the identical
chain below; only the schema/prompt at the call site differs.)

| Layer | File | Responsibility |
| --- | --- | --- |
| AI Service | `src/server/ai/service.ts` | What callers actually use (`tryGenerateStructured`). Resolves the configured provider, **never throws** — any failure degrades to `null` so a caller's deterministic fallback runs. |
| AI Gateway | `src/server/ai/gateway.ts` | `runAIGeneration`: calls the provider with a timeout (10s default), validates the response against the request's Zod schema, normalizes failures into typed errors. |
| AIProvider | `src/server/ai/providers/*.ts` | One implementation per vendor. `none` (`AI_PROVIDER=none`, the default — every call fails with `AIDisabledError`), `openrouter`, and `mistral` (both Phase 6, real HTTP adapters) are real, resolvable providers today. `gigachat`/`yandex` are recognized but not implemented (see docs/integration-architecture.md#why-gigachatyandex-ai-arent-real-adapters-yet). `fake.ts` is test-only, never reachable from `AI_PROVIDER`. |

## Provider selection

Configuration-driven, via the `AI_PROVIDER` environment variable
(`src/lib/env.ts`, `z.enum(["none", "gigachat", "yandex", "openrouter", "mistral"])`, default `"none"`):

```
AI_PROVIDER=none        # default — AI features degrade gracefully, no credentials needed
AI_PROVIDER=mistral     # PAYNORA's primary production provider (Phase 21A) — real adapter, requires MISTRAL_API_KEY/MISTRAL_MODEL
AI_PROVIDER=openrouter  # also a real adapter (Phase 6); requires OPENROUTER_API_KEY/OPENROUTER_MODEL
AI_PROVIDER=gigachat    # resolves to AIProviderError today — adapter not implemented yet
```

`src/server/ai/service.ts`'s `resolveProviderByName` is the one place that
knows which vendor values exist; nothing else in the codebase imports a
provider module directly. See
[docs/ai-integration.md](./ai-integration.md) for the full Mistral
production-setup guide and
[docs/integration-architecture.md#ai-routing](./integration-architecture.md#ai-routing)
for the routing/fallback design (`AI_PROVIDER_FALLBACK`, bounded attempts,
retryable-vs-non-retryable classification).

## Failure handling

1. **AI failures must never corrupt financial/business data.** Neither
   `src/server/operator/*` nor `src/server/communications/*` ever writes
   to `Invoice`, `Payment`, or `Customer` — they only read AR data and
   write their own tables, so an AI failure has no path to reach
   financial state at all. When AI is disabled or fails, insight creation
   falls back to a deterministic summary template
   (`buildDeterministicSummary` in `src/server/operator/insights.ts`) and
   email drafting falls back to a deterministic template
   (`buildDeterministicReminderEmail` in
   `src/server/communications/templates.ts`) rather than blocking either.
2. **AI output is untrusted external output.** Every response is validated
   against the request's Zod schema (`runAIGeneration` in
   `src/server/ai/gateway.ts`) before any caller sees it; a response that
   fails validation is discarded, not partially trusted. See `SECURITY.md`.
3. **Customer-supplied text is data, never instructions.** `AIRequest`
   structurally separates `system` from `input` — see
   [docs/operator-foundation.md#prompt-injection-defense](./operator-foundation.md#prompt-injection-defense)
   and `src/server/communications/ai-context.test.ts` for concrete tests
   (one per caller) proving this holds even against an adversarial
   customer note, and that an AI response for an email draft has no field
   that could change who it's sent to or what amount it states.

## Testing without a real AI account

`src/server/ai/providers/fake.ts` is a deterministic, in-memory
`AIProvider` used only by tests (`success` / `invalid` / `error` / `hang`
behaviors, covering the valid, invalid-output, provider-failure, and
timeout cases). No real vendor SDK and no network call are involved
anywhere in the test suite or CI — `AI_PROVIDER` is unset in
`vitest.config.mts`, so it defaults to `"none"` the same as a fresh
production deploy with no AI credentials configured.

## Cost and usage tracking

`AIResult.usage` (`promptTokens`/`completionTokens`) is populated for both
real adapters (OpenRouter, Mistral) from the vendor's own reported
`usage.prompt_tokens`/`usage.completion_tokens` — see
`src/server/ai/providers/openai-compatible-chat.ts`. There is still no
aggregation/dashboard over these numbers (deferred, same as before); what
Phase 21A did add is a real bound on worst-case output cost —
`AIRequest.maxOutputTokens`, set by every real call site
(`src/server/operator/ai-context.ts`, `copilot/ai-context.ts`,
`communications/ai-context.ts`, `websearch/decision.ts`) to a value sized
for that feature's own schema ceiling, and forwarded to the wire-level
`max_tokens` parameter both adapters already supported. See
[docs/ai-integration.md#cost-control](./ai-integration.md#cost-control).
