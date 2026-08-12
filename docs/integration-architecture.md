# Integration & Provider Foundation (Phase 6)

This document describes the cross-cutting provider architecture added in
Phase 6: what exists as a real, tested implementation today; what exists
only as a boundary/type/documentation with no real adapter; and what is
intentionally not represented in code at all yet. Read this alongside
`docs/provider-strategy.md` (the original boundary list and the
Russia-accessibility constraint that drives every vendor choice in this
project) and `docs/ai-architecture.md` / `docs/communications.md` (the two
provider categories that predate this phase).

**Nothing in this phase claims an integration is production-ready before a
real vendor account is actually connected and exercised.** The status
table below is the single source of truth for that distinction — read it
before assuming any vendor "works."

## Status at a glance

| Category | Vendor | Status |
| --- | --- | --- |
| AI | OpenRouter | Implemented — real HTTP adapter, mocked-network tests. Not exercised against the real OpenRouter API (no credential in CI). |
| AI | Mistral | Implemented — same as OpenRouter. |
| AI | GigaChat | Recognized, not implemented. Selecting it throws a clear "not implemented yet" error. See [Why GigaChat/Yandex AI aren't real adapters yet](#why-gigachatyandex-ai-arent-real-adapters-yet). |
| AI | Yandex AI | Recognized, not implemented. Same as GigaChat. |
| Email | SMTP | Implemented since Phase 4 — unchanged by Phase 6. Outlook/Microsoft 365 (SMTP AUTH) and Yandex Mail both work today as SMTP configuration, not new code — see [Email: no new adapter needed](#email-no-new-adapter-needed). |
| Messaging | Telegram | Implemented — real Bot API adapter, mocked-network tests. **No domain code calls it yet** — see [Messaging: a foundation with no caller](#messaging-a-foundation-with-no-caller). |
| Billing | Stripe | Types + normalized contract only. No SDK call, no Prisma schema. Selecting it throws "not implemented yet." |
| Billing | YooKassa | Same as Stripe. |
| Storage, Accounting, CRM, Banking | — | Not represented in code at all. Documented as planned only — see [Documented-only boundaries](#documented-only-boundaries). |

## Why this phase exists

Phase 3–5 each added exactly one provider category because a concrete
feature needed it (`AIProvider` for Operator insights, `EmailProvider` for
sending reminders). Phase 6 is different: it prepares the *shape* PAYNORA
integrates with the outside world through, ahead of the features that will
actually drive AI vendor choice, messaging, and billing in Phase 7+ — so
that when those features arrive, they extend an existing pattern instead
of inventing a new one per integration.

The scope discipline from `docs/provider-strategy.md`'s rule — "do not
implement a provider adapter before the phase that needs it" — still
applies. Phase 6 does not violate it: every adapter implemented here
(OpenRouter, Mistral, Telegram) has a stable, public, documented REST
contract that can be built and unit-tested *correctly* without a real
credential, via dependency-injected `fetch` mocking. Every category left
at "types only" or "not represented at all" is one where a correct
implementation genuinely requires a real account (GigaChat/Yandex AI's
OAuth/mTLS flows, Stripe/YooKassa's SDKs and webhook infrastructure) or has
no concrete use case anywhere in this codebase yet (Storage, Accounting,
CRM, Banking).

## Provider architecture

```
PAYNORA domain code
  -> Integration/Provider layer (this phase)
       AIProvider          src/server/ai/          (Phase 3, extended Phase 6)
       EmailProvider        src/server/email/        (Phase 4, unchanged)
       MessagingProvider     src/server/messaging/     (Phase 6, new)
       BillingProvider        src/server/billing/       (Phase 6, new — types only)
       [StorageProvider, AccountingProvider, CRMProvider, BankingProvider — documented, not implemented]
```

Every implemented category (AI, Email, Messaging) follows the identical
five-part shape, deliberately — this is what makes the pattern
recognizable and predictable across the whole codebase instead of each
category inventing its own conventions:

1. **`types.ts`** — the vendor-neutral request/response contract
   (`AIProvider`/`EmailProvider`/`MessagingProvider` interface) and its
   message/result types.
2. **`errors.ts`** — a fixed, small set of normalized error classes. Each
   category has a "definite failure" class (`EmailProviderRejectedError`,
   `MessagingProviderRejectedError`) that a provider may only throw when
   it is *certain* the operation didn't succeed; every other failure mode
   (timeout, network error, unrecognized exception) is normalized into an
   "unknown outcome" class and must never be treated as a confirmed
   failure — see `docs/communications.md#unknown-outcomes`, the pattern
   this was first established under.
3. **`gateway.ts`** — the one place a provider is actually invoked. Wraps
   the call in a timeout, normalizes every failure into the category's
   error classes, and records structured telemetry (see
   [Observability](#observability)) for every call regardless of caller.
4. **`providers/none.ts`** — the default when the category's env var is
   `"none"`; every call throws that category's `*DisabledError`.
5. **`providers/fake.ts`** — a deterministic, in-memory test double
   (`{kind: "success" | "rejected" | "error" | "hang"}`) with no network
   call — what keeps CI free of any real vendor dependency.

`BillingProvider` (see [Billing](#billing)) deliberately does not follow
this full shape: it has no gateway, because verifying and parsing a
webhook is synchronous and has no network call or timeout to wrap. Its
`types.ts`/`errors.ts`/`providers/none.ts` still exist, for the same
reason and following the same convention.

Domain logic never imports a vendor SDK or a provider module directly —
only a category's `service.ts` (`resolveEmailProvider`,
`resolveMessagingProvider`, `resolveBillingProvider`, and AI's
`resolveProviderByName`/`tryGenerateStructured`) does that. This is what
makes swapping a vendor a configuration change, never a code change — the
central requirement from `docs/provider-strategy.md`.

## AI routing

`AIProvider` (Phase 3) is extended, not replaced. `AI_PROVIDER` now
accepts five values: `none` (default), `gigachat`, `yandex`, `openrouter`,
`mistral`. A new optional `AI_PROVIDER_FALLBACK` (any of the four real
vendor names, must differ from `AI_PROVIDER`) enables a single, bounded
fallback attempt.

**Routing semantics** (`src/server/ai/service.ts#tryGenerateStructured`):

- At most two attempts: the primary (`AI_PROVIDER`), then the fallback
  (`AI_PROVIDER_FALLBACK`) only if configured — never a longer chain,
  never retried past a confirmed success, never retried at all after
  either attempt resolves.
- Stops at the first confirmed success (schema-validated output, via the
  existing central Zod validation in `src/server/ai/gateway.ts` — a
  provider casts its parsed JSON `as T` and trusts the gateway to check
  it, exactly as established in Phase 3).
- A provider that's recognized-but-unimplemented (`gigachat`/`yandex`),
  misconfigured, timed out, errored, or returned invalid output is logged
  and treated as "try the next one" — never thrown out of
  `tryGenerateStructured`, which (unchanged since Phase 3) never throws:
  every failure degrades to `null`, and every caller already has a
  deterministic fallback for "no AI result."

**Vendor adapters implemented**: OpenRouter and Mistral
(`src/server/ai/providers/openrouter.ts`, `mistral.ts`), both real HTTP
adapters against each vendor's OpenAI-compatible `/chat/completions`
endpoint, sharing one wire-level helper
(`src/server/ai/providers/openai-compatible-chat.ts`) because it is
genuinely the same contract for both today. `OPENROUTER_API_KEY`/
`OPENROUTER_MODEL` and `MISTRAL_API_KEY`/`MISTRAL_MODEL` are read lazily
at call time (the same pattern as Phase 4's SMTP adapter), so importing
these modules is always safe even when unconfigured — `src/lib/env.ts`'s
cross-field validation refuses to boot if either is selected (as primary
or fallback) without its required configuration.

Both adapters take an injectable `fetchImpl` (default: the real global
`fetch`), the same dependency-injection shape as every other test-only
override in this codebase — see `src/server/ai/providers/openrouter.test.ts`
and `mistral.test.ts`, which verify request URL/headers/body shape,
response parsing (including `usage` mapping), and error classification
entirely against a mocked `fetch`, with **no real network call and no real
API key anywhere in the suite**.

### Why GigaChat/Yandex AI aren't real adapters yet

Both require an OAuth/token-exchange flow this project cannot build and
test *correctly* without a real account: GigaChat's authentication is
mTLS/Russian-CA-certificate-based, and Yandex AI's is an IAM-token flow.
Building either against guesswork would risk shipping a broken adapter
that looks implemented — worse than being honest that it isn't. They stay
selectable (recognized by `AI_PROVIDER`, listed in the provider registry)
so choosing one gives a clear, typed "not implemented yet" error instead
of an unrecognized value or silent no-op; implementing either for real is
future work once there's a real account to test against.

## Email: no new adapter needed

Phase 6's brief mentioned Outlook/Microsoft and Yandex Mail as candidate
Email vendors. Neither needed new code: both are SMTP endpoints, already
fully served by the existing generic `smtp` `EmailProvider`
(`src/server/email/providers/smtp.ts`) via configuration
(`SMTP_HOST`/`PORT`/`USER`/`PASSWORD`) — no vendor-specific code path.

One real gap is documented, not built: Microsoft 365 tenants that have
disabled legacy SMTP AUTH (increasingly the default) require OAuth2 via
the Microsoft Graph API instead. That is a genuinely different adapter
(different auth, different send endpoint) and is left for the phase that
actually needs it, per `docs/provider-strategy.md`'s rule — building it
now, with no Microsoft tenant to test against, would risk exactly the
kind of "looks implemented but untested" adapter GigaChat/Yandex AI were
deliberately not built as.

## Messaging

New category, mirroring Email's exact shape:
`src/server/messaging/{types,errors,gateway,service}.ts`,
`providers/{none,fake,telegram}.ts`. `MESSAGING_PROVIDER` (`none`
default, or `telegram`) and `TELEGRAM_BOT_TOKEN` (required once
`telegram` is selected) are Zod-validated in `src/lib/env.ts`.

The Telegram adapter (`src/server/messaging/providers/telegram.ts`) is a
real HTTP adapter against the Bot API's `sendMessage` method
(`POST https://api.telegram.org/bot<token>/sendMessage`), reading
`TELEGRAM_BOT_TOKEN` lazily and taking an injectable `fetchImpl`, the same
pattern as the AI adapters. It classifies Telegram's `error_code` into a
definite rejection (`400` chat-not-found, `403` bot-blocked-by-user) vs.
an unknown outcome (rate limiting, 5xx, network failure) — see
`src/server/messaging/providers/telegram.test.ts`, entirely mocked-`fetch`,
no real bot token anywhere in the suite. Errors never include the request
URL (it embeds the bot token as a path segment) or the raw response body —
only the status code and Telegram's own `description` field.

### Messaging: a foundation with no caller

**No domain code constructs a `MessagingMessage` or calls
`dispatchMessage` anywhere in this codebase today.** This is deliberate,
matching exactly how `AIProvider` itself started in Phase 3 (a real
gateway with no caller until Phase 3's Operator pipeline needed it): the
provider boundary and a real adapter exist so a future phase can add
operator notifications (e.g., "sequence paused due to uncertain delivery")
or interactive Telegram actions (approve/reject/pause/open-invoice from a
chat) without first building the provider layer from scratch — but Phase 6
does not invent that feature to give the provider a caller. Building a
notification feature "to have something to call this" would be exactly
the padding the Phase 6 brief explicitly ruled out.

**Security note**: because there is no caller yet, there is also no
existing authorization boundary a future Telegram integration could
bypass — but the constraint stands for whenever one is built: an
interactive Telegram action must re-verify the acting user's real PAYNORA
authorization server-side (the same way every other mutation in this
codebase does via `src/server/tenancy/context.ts`) before taking effect —
a Telegram chat ID is never itself proof of identity or authorization.

## Billing

`src/server/billing/{types,errors,service}.ts`,
`providers/none.ts`. Distinct from Email/Messaging's shape by design (see
[Provider architecture](#provider-architecture)): `BillingProvider` has
one method, `verifyAndParseWebhook(rawBody, signatureHeader)`, and no
gateway — webhook verification is synchronous with no network call to
wrap in a timeout.

**`BillingProvider` here is PAYNORA's own subscription billing** — what a
PAYNORA customer organization pays PAYNORA to use the product. This is a
distinct domain concept from AR/collections (Phase 2–5): what a PAYNORA
customer organization's *own* customers pay *them* on an `Invoice`.
Nothing in `src/server/billing/` touches `Invoice`/`Payment`
(`src/server/ar/*`), and nothing in this phase changes that.

Normalized types anticipate what a real subscription domain (Phase 7,
per `ROADMAP.md`) will need: `BillingCustomerId`/`BillingSubscriptionId`
(opaque, vendor-assigned), `BillingSubscriptionStatus` (a shared
vocabulary — `active`/`trialing`/`past_due`/`canceled`/`incomplete`/
`unpaid` — vendor-specific status strings are normalized into this, never
passed through raw), `WebhookEventIdentity` (`{provider, eventId}` — the
idempotency boundary a future billing domain must check before applying
an event, since providers retry webhook delivery), and
`NormalizedSubscriptionEvent` (a verified webhook reduced to exactly the
fields a future domain needs, with an optional `planId` for future
plan-mapping logic).

**A `BillingProvider` must never itself change financial state.** Its one
job is verification and normalization — parsing a webhook into a
`NormalizedSubscriptionEvent` and handing it back to its (future) caller,
which applies domain rules including its own idempotency check against
`eventIdentity.eventId`. `verifyAndParseWebhook` must throw
(`BillingWebhookVerificationError`), never return a best-guess result, on
a failed authenticity check — a forged webhook must never reach domain
code labeled as legitimate.

**Explicitly not built in Phase 6**: no Prisma schema (PAYNORA's own
subscription state has no table yet — adding one with nothing reading or
writing it would be dead code, per `docs/provider-strategy.md`'s rule), no
real Stripe/YooKassa SDK call, no fictional "production-looking" billing
flow. Selecting `stripe`/`yookassa` via `BILLING_PROVIDER` resolves to a
clear `BillingProviderNotImplementedError`, the same precedent as AI's
`gigachat`/`yandex`. The actual subscription domain is Phase 7
"Monetization" work, per `ROADMAP.md` (unchanged by this phase).

## Provider Registry

`src/server/providers/` is new, cross-cutting infrastructure with no
existing precedent to mirror — it doesn't belong to any one category.

- **`types.ts`**: `DeploymentProfile` (`RU | GLOBAL | LOCAL_TEST`),
  `ProviderCategory` (`ai | email | messaging | billing`),
  `ProviderHealthStatus` (`HEALTHY | DEGRADED | DOWN | DISABLED |
  UNKNOWN`), `ProviderRegistryEntry`, `ProviderRegistrySnapshot`.
- **`registry.ts`**: `getProviderRegistrySnapshot()` — a pure, synchronous
  function turning current environment configuration into a reportable
  snapshot across every category. `getRecommendedVendors(profile,
  category)` — a documentation/future-setup-UI table, never enforced.
- **`telemetry.ts`**: see [Observability](#observability).

## Deployment profiles

`DEPLOYMENT_PROFILE` (`RU | GLOBAL | LOCAL_TEST`, default `LOCAL_TEST`) is
**purely descriptive metadata** — it labels which vendor set a deployment
is expected to run, for documentation and a future setup UI, and is never
enforced as a hard restriction against which vendor is actually selected.
One codebase, different configurations — never two codebases, and never a
restriction that would stop, say, a RU-based team legitimately billing an
international customer through Stripe.

Example recommended mappings (`getRecommendedVendors`, not enforced):

| Profile | AI | Billing | Email | Messaging |
| --- | --- | --- | --- | --- |
| `RU` | gigachat, yandex, openrouter, mistral | yookassa | smtp | telegram |
| `GLOBAL` | openrouter, mistral | stripe | smtp | telegram |
| `LOCAL_TEST` | none | none | none | none |

### Health model

`ProviderHealthStatus` is **configuration-derived only — Phase 6 never
performs a live network probe.** A "health check" that itself sends a
real email, spends a paid AI call, or posts a real Telegram message would
be a side effect, not a safe check; `resolveHealth` (`registry.ts`) only
looks at whether a vendor is selected and whether a real adapter exists
behind it:

- `none` → `DISABLED`.
- Selected, no real adapter (`gigachat`, `stripe`, ...) → `UNKNOWN`.
- Selected, real adapter exists → `HEALTHY` (on the assumption its
  required configuration already passed Zod validation at boot — if it
  hadn't, the process would never have started).

`DEGRADED`/`DOWN` are defined in the type and **never produced by any code
in this phase** — reserved honestly for a future real health-check
mechanism (e.g., a periodic lightweight probe with its own explicit
side-effect budget) so a future "PAYNORA Control Center" page doesn't need
a breaking type change when that mechanism is added.

## Observability

`src/server/providers/telemetry.ts#recordProviderTelemetry` is a single,
narrow, secret-free logging boundary — `{category, provider, operation,
result, durationMs, errorCode?, requestId?, organizationId?}`. Nothing
else is representable: there is no field for an API key, password, email
body, invoice content, authorization header, or raw webhook payload to
land in, and it is enforced structurally (TypeScript rejects an unlisted
field), not just by convention.

**Wired into every category's gateway** (`ai/gateway.ts#runAIGeneration`,
`email/gateway.ts#dispatchEmail`, `messaging/gateway.ts#dispatchMessage`)
— the real choke point regardless of caller, so every call is recorded
whether it goes through a category's `service.ts` or (in tests) directly.
Today this only writes one structured line via `console.info` (success) /
`console.error` (failure or timeout) — the same logging primitive
`src/server/collections/engine.ts` and `src/server/operator/pipeline.ts`
already use. This is the single choke point a future real observability
vendor (Sentry, PostHog — both listed as future candidates in
`docs/provider-strategy.md`) would be wired in behind, without touching
any of the provider gateways that call it.

## Secrets

Rules enforced throughout this phase, at every new call site:

- **Never sent to the client.** Every provider adapter and every secret
  env var (`OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `TELEGRAM_BOT_TOKEN`,
  ...) lives under `src/server/` or `src/lib/env.ts`, never imported by a
  client component.
- **Never logged.** `recordProviderTelemetry`'s fixed shape has no field a
  secret could occupy (see [Observability](#observability)).
  `logAIFailure` (`src/server/ai/service.ts`) logs an error's `name`/
  `message` only, never the request. The Telegram adapter's error path
  never includes the request URL (embeds the bot token) or raw response
  body — only the status code and Telegram's own `description` field.
  OpenRouter/Mistral's shared HTTP helper
  (`openai-compatible-chat.ts`) never includes the response body or any
  request header (would include the `Authorization` bearer) in a thrown
  error — only the HTTP status code.
- **Never stored raw in an audit event.** No new `ActivityEvent` types
  were added in Phase 6 (no domain call site exists yet for
  Messaging/Billing to audit); when Phase 7 adds one, this rule carries
  forward unchanged from every earlier phase's audit trail.
- **Never included in analytics.** No analytics integration exists yet
  (see [Documented-only boundaries](#documented-only-boundaries)); this is
  a constraint on whatever is built later, recorded here so it isn't
  relitigated per-integration.
- **Never committed.** `.env.example` documents every new variable name
  with a placeholder/example only — see the file itself for the current
  list.
- **Test coverage**: `openrouter.test.ts`, `mistral.test.ts`,
  `telegram.test.ts` each assert directly that a thrown error's message
  never contains the configured secret, even when the mocked vendor
  response body itself contains something secret-shaped — proving the
  adapter's own error construction is the safe boundary, not an assumption
  about what the vendor happens to return.

## Not-implemented boundaries

### Documented-only boundaries

Storage, Accounting, CRM, and Banking have **zero TypeScript files** in
this phase — no `types.ts`, no directory, nothing. Each was named in the
Phase 6 brief as a category to prepare room for, but none has any existing
domain use case anywhere in this codebase today (no document upload, no
1С/Bitrix24/amoCRM/bank sync feature exists or is being built). Creating
an unused interface for any of them would be exactly the dead code
`docs/provider-strategy.md`'s rule exists to prevent. They remain
documented as planned candidates only:

| Category | Candidate vendors | Trigger for real implementation |
| --- | --- | --- |
| Storage | S3-compatible object storage, Yandex Object Storage | The first feature that needs to store a file/document (e.g. invoice PDF attachments) |
| Accounting | 1С, Bitrix24, amoCRM | Phase 8 "Integrations," per `ROADMAP.md`, and only per validated customer demand |
| CRM | Bitrix24, amoCRM | Same as Accounting |
| Banking | Bank statement/transaction APIs | Phase 8, same as above |
| Import | CSV/XLSX invoice import | The first phase that needs bulk invoice onboarding |
| Analytics | PostHog | Phase 7/8, per `docs/provider-strategy.md`'s existing `AnalyticsProvider` entry |
| Error tracking | Sentry | Same trigger as Analytics — both are candidates behind the [Observability](#observability) choke point already in place, not yet connected to either |

### Recognized-but-unimplemented vendors (already covered above)

GigaChat, Yandex AI (see
[Why GigaChat/Yandex AI aren't real adapters yet](#why-gigachatyandex-ai-arent-real-adapters-yet)),
Stripe, YooKassa (see [Billing](#billing)) are all selectable via their
category's env var and all resolve to a clear, typed "not implemented
yet" error — never a silent no-op, never an unrecognized-value crash.
