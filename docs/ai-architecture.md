# AI Architecture

**Status: design direction for Phase 3. No `AIProvider` code exists yet.**
`src/lib/env.ts` reserves the `AI_PROVIDER` variable (defaulting to
`"none"`) so the configuration surface is stable, but nothing reads it yet.

## Why an abstraction

The initial AI provider is GigaChat, chosen because the project must be
developable and testable from Russia without a foreign card or an
OpenAI/Anthropic account, and because it minimizes infrastructure cost
during early development. PAYNORA itself must not depend on GigaChat
directly — the choice of AI vendor is an infrastructure decision, not a
product one, and a sellable asset shouldn't be hard-wired to a single
vendor chosen for the founder's early circumstances.

## Interface (planned shape)

```ts
interface AIProvider {
  generateReminder(input: ReminderContext): Promise<GeneratedReminder>;
  classifyReply(input: ReplyContext): Promise<ReplyClassification>;
  extractPaymentPromise(input: ReplyContext): Promise<PaymentPromiseExtraction | null>;
  summarizeCustomerHistory(input: CustomerHistoryContext): Promise<string>;
}
```

Exact input/output types are defined when Phase 3 implements them, informed
by what GigaChat's API actually returns — this signature is a direction,
not a contract to build against yet.

## Provider selection

Configuration-driven, via the `AI_PROVIDER` environment variable already
reserved in `src/lib/env.ts`:

```
AI_PROVIDER=gigachat
```

Future values may include `yandexgpt`, `openrouter`, `mistral`, `openai`,
`anthropic`. Only the provider(s) an actual phase needs get implemented —
this list is not a queue of work to do now.

## Failure handling

Two rules apply from the first implementation onward:

1. **AI failures must never corrupt financial/business data.** An AI call
   that fails, times out, or returns malformed output must leave invoices,
   payments, and statuses exactly as they were. The reminder-generation
   flow degrades to "AI unavailable, draft manually" rather than guessing.
2. **AI output is untrusted external output.** It is validated against a
   Zod schema before use, the same as any other external input (see
   `SECURITY.md`). Free-text customer replies fed into the AI provider are
   themselves untrusted — prompt-injection risk is considered explicitly
   before any such content is included in a prompt.

## Cost and usage tracking

Deferred to Phase 3/Phase 7 (Observability) — not needed until there is an
actual AI call to track.
