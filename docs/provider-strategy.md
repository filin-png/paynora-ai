# Provider Strategy

**Status: `AIProvider`'s interface and Gateway are implemented (Phase 3);
every other provider below is not implemented yet, and `AIProvider` has no
real vendor adapter behind it either** — see `docs/ai-architecture.md`.
This document records the intended boundary and the constraint driving it,
so each phase that adds a provider has a consistent pattern to follow
instead of inventing one per integration.

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
| `AIProvider`          | Structured AI generation (Operator insight wording) | GigaChat        | Interface + Gateway implemented (Phase 3); no vendor adapter yet |
| `EmailProvider`       | Transactional & collection email          | TBD at Phase 4           | Not implemented (Phase 4) |
| `PaymentProvider`     | PAYNORA's own subscription billing        | TBD at Phase 6           | Not implemented (Phase 6) |
| `AnalyticsProvider`   | Product analytics                         | TBD at Phase 7/8          | Not implemented |
| `StorageProvider`     | File/document storage                     | TBD when first needed     | Not implemented |
| `JobProvider`         | Background job scheduling                 | TBD at Phase 4            | Not implemented (Phase 4) |

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
