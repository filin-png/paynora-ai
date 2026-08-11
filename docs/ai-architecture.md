# AI Architecture

**Status: the AI Gateway foundation is implemented (Phase 3). No real
vendor adapter is wired up yet** — `AI_PROVIDER=none` is the default and
the only fully-implemented value; selecting `gigachat` resolves to a clear
`AIProviderError` rather than a real integration. See
[docs/operator-foundation.md](./operator-foundation.md) for how this is
actually used by the Operator pipeline, the only feature that calls it so
far.

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
  generateStructured<T>(request: AIRequest<T>): Promise<AIResult<T>>;
}
```

One generic method, not one per feature (`generateReminder`,
`classifyReply`, ...): every AI-assisted feature describes its own
input/output shape with a Zod schema and passes it to
`generateStructured`, so adding a new AI-assisted feature never requires
touching a provider adapter — only a new schema and prompt at the call
site (see `src/server/operator/ai-context.ts` for the one example that
exists so far). This ended up simpler than the per-feature interface
sketched in earlier drafts of this document, and covers the same ground.

## The chain: Operator → AI Service → AI Gateway → AIProvider

| Layer | File | Responsibility |
| --- | --- | --- |
| AI Service | `src/server/ai/service.ts` | What callers actually use (`tryGenerateStructured`). Resolves the configured provider, **never throws** — any failure degrades to `null` so a caller's deterministic fallback runs. |
| AI Gateway | `src/server/ai/gateway.ts` | `runAIGeneration`: calls the provider with a timeout (10s default), validates the response against the request's Zod schema, normalizes failures into typed errors. |
| AIProvider | `src/server/ai/providers/*.ts` | One implementation per vendor. Only `none` (`AI_PROVIDER=none`, the default — every call fails with `AIDisabledError`) exists as a real, resolvable provider today. `fake.ts` is test-only, never reachable from `AI_PROVIDER`. |

## Provider selection

Configuration-driven, via the `AI_PROVIDER` environment variable
(`src/lib/env.ts`, `z.enum(["none", "gigachat"])`, default `"none"`):

```
AI_PROVIDER=none      # default — AI features degrade gracefully, no credentials needed
AI_PROVIDER=gigachat  # resolves to AIProviderError today — adapter not implemented yet
```

`src/server/ai/service.ts`'s `resolveProvider` is the one place that knows
which vendor values exist; nothing else in the codebase imports a
provider module directly. Future values may include `yandexgpt`,
`openrouter`, `mistral`, `openai`, `anthropic` — only the provider an
actual phase needs gets implemented, per `docs/provider-strategy.md`'s
rule against building a provider before its phase.

## Failure handling

1. **AI failures must never corrupt financial/business data.** Nothing in
   `src/server/operator/*` writes to `Invoice`, `Payment`, or `Customer` —
   the Operator pipeline only reads AR data and writes its own
   `BusinessEvent`/`OperatorInsight`/`ActionProposal` tables, so an AI
   failure has no path to reach financial state at all. When AI is
   disabled or fails, insight creation falls back to a deterministic
   summary template (`buildDeterministicSummary` in
   `src/server/operator/insights.ts`) rather than blocking.
2. **AI output is untrusted external output.** Every response is validated
   against the request's Zod schema (`runAIGeneration` in
   `src/server/ai/gateway.ts`) before any caller sees it; a response that
   fails validation is discarded, not partially trusted. See `SECURITY.md`.
3. **Customer-supplied text is data, never instructions.** `AIRequest`
   structurally separates `system` from `input` — see
   [docs/operator-foundation.md#prompt-injection-defense](./operator-foundation.md#prompt-injection-defense)
   for the concrete test proving this holds even against an adversarial
   customer note.

## Testing without a real AI account

`src/server/ai/providers/fake.ts` is a deterministic, in-memory
`AIProvider` used only by tests (`success` / `invalid` / `error` / `hang`
behaviors, covering the valid, invalid-output, provider-failure, and
timeout cases). No real vendor SDK and no network call are involved
anywhere in the test suite or CI — `AI_PROVIDER` is unset in
`vitest.config.mts`, so it defaults to `"none"` the same as a fresh
production deploy with no AI credentials configured.

## Cost and usage tracking

`AIResult.usage` (`promptTokens`/`completionTokens`) is already part of
the type, populated when a provider reports it — but there is no real
provider to populate it yet, and no aggregation/dashboard. Deferred to
whichever phase wires up a real vendor and to Phase 7 (Observability).
