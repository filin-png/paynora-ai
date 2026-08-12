# Provider Strategy

**Status: `AIProvider` (Phase 3, extended Phase 6), `EmailProvider`
(Phase 4), and `MessagingProvider` (Phase 6) are implemented.
`BillingProvider` (Phase 6) is a normalized types/contract only — no real
adapter. `AIProvider` now has two real vendor adapters (OpenRouter,
Mistral); GigaChat/Yandex AI remain recognized but not implemented.
`EmailProvider` has an SMTP adapter, not a vendor SDK (see below).
`MessagingProvider` has a real Telegram adapter with no domain caller yet.
Every other provider below is not implemented yet.** See
`docs/ai-architecture.md`, `docs/communications.md`, and, for the full
Phase 6 design (routing, health model, deployment profiles, telemetry,
and exactly why each category stopped where it did),
`docs/integration-architecture.md`. This document records the intended
boundary and the constraint driving it, so each phase that adds a
provider has a consistent pattern to follow instead of inventing one per
integration.

## Why this matters for a sellable asset

A buyer evaluating PAYNORA should be able to swap any external vendor
without touching business logic, and should never inherit a dependency on
the founder's personal foreign accounts. Every external capability is
therefore represented as an interface owned by PAYNORA, with vendor SDKs
confined to a single adapter module implementing that interface.

## Development-environment constraint

The project is developed from Russia. The core development and testing
workflow must not require a foreign bank card, Stripe, OpenAI, Anthropic,
Vercel, Clerk, or another foreign commercial service that may be
inaccessible. Preference order for any new provider:

1. Works from Russia.
2. Has a free development tier.
3. Can be replaced later without rewriting core application logic (this is
   what the interface boundary guarantees regardless of which vendor is
   chosen first).

International providers may be added later as alternates behind the same
interface — this is an ordering decision, not a permanent exclusion.

## Provider boundaries

| Boundary            | Purpose                                   | Initial candidate       | Status        |
| -------------------- | ------------------------------------------ | ------------------------ | -------------- |
| `AIProvider`          | Structured AI generation (insight/email wording) | OpenRouter, Mistral (real); GigaChat, Yandex AI (recognized) | Interface + Gateway implemented (Phase 3); routing/fallback + two real vendor adapters (Phase 6) — see `docs/integration-architecture.md#ai-routing` |
| `EmailProvider`       | Transactional payment-reminder email       | SMTP (any relay)         | Implemented (Phase 4) — see `docs/communications.md#provider-abstraction` |
| `MessagingProvider`   | Operator notifications, future interactive actions | Telegram | Implemented (Phase 6) — real Bot API adapter, no domain caller yet, see `docs/integration-architecture.md#messaging` |
| `BillingProvider`     | PAYNORA's own subscription billing        | Stripe, YooKassa         | Types/contract only (Phase 6); real adapter + Prisma schema is Phase 8 — see `docs/integration-architecture.md#billing` |
| `AnalyticsProvider`   | Product analytics                         | PostHog                  | Not implemented — candidate documented in `docs/integration-architecture.md#documented-only-boundaries` |
| `StorageProvider`     | File/document storage                     | S3-compatible, Yandex Object Storage | Not implemented — no current use case, see `docs/integration-architecture.md#documented-only-boundaries` |
| `AccountingProvider`, `CRMProvider`, `BankingProvider` | Customer-facing integrations (1С, Bitrix24, amoCRM, bank APIs) | TBD, only per validated customer demand | Not implemented — Phase 9, documented only |
| `JobProvider`         | Background job scheduling                 | TBD at a future phase, if one ever needs scheduled/automated sends | Not implemented — Phase 4's "Send" is a synchronous, human-triggered action, deliberately not queued |

Note: `BillingProvider` here is PAYNORA's own subscription billing
(Phase 6 types, Phase 8 real implementation), distinct from the Phase 9
"integrations" work that connects to a *customer's* accounting/payment
infrastructure (QuickBooks, Xero, regional processors) — PAYNORA
integrates with that infrastructure, it does not replace it.

## Rule

Do not implement a provider adapter before the phase that needs it. An
interface with no real implementation and no caller is dead code; it gets
created at the moment a phase's business logic needs to call through it,
not before.
