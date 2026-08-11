# Provider Strategy

**Status: `AIProvider` (Phase 3) and `EmailProvider` (Phase 4) are
implemented. `AIProvider` has no real vendor adapter behind it yet;
`EmailProvider` does — an SMTP adapter, not a vendor SDK (see below).
Every other provider below is not implemented yet.** See
`docs/ai-architecture.md` and `docs/communications.md`. This document
records the intended boundary and the constraint driving it, so each
phase that adds a provider has a consistent pattern to follow instead of
inventing one per integration.

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
| `AIProvider`          | Structured AI generation (insight/email wording) | GigaChat        | Interface + Gateway implemented (Phase 3); no vendor adapter yet |
| `EmailProvider`       | Transactional payment-reminder email       | SMTP (any relay)         | Implemented (Phase 4) — see `docs/communications.md#provider-abstraction` |
| `PaymentProvider`     | PAYNORA's own subscription billing        | TBD at Phase 6           | Not implemented (Phase 6) |
| `AnalyticsProvider`   | Product analytics                         | TBD at Phase 7/8          | Not implemented |
| `StorageProvider`     | File/document storage                     | TBD when first needed     | Not implemented |
| `JobProvider`         | Background job scheduling                 | TBD at a future phase, if one ever needs scheduled/automated sends | Not implemented — Phase 4's "Send" is a synchronous, human-triggered action, deliberately not queued |

Note: `PaymentProvider` here is PAYNORA's own subscription billing
(Phase 6), distinct from the Phase 7 "integrations" work that connects to a
*customer's* accounting/payment infrastructure (QuickBooks, Xero, regional
processors) — PAYNORA integrates with that infrastructure, it does not
replace it.

## Rule

Do not implement a provider adapter before the phase that needs it. An
interface with no real implementation and no caller is dead code; it gets
created at the moment a phase's business logic needs to call through it,
not before.
