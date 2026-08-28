# Data Flows (Phase 15A)

Every real network call this codebase makes that leaves PAYNORA's own
infrastructure, traced from the actual adapter code — see
`docs/privacy-data-inventory.md` for what each flow's data actually
contains, and `docs/production-integrations.md` for setup/cost/security
detail per provider. All processing described here happens at whatever
region the deployment's own servers and the vendor's chosen endpoint run
in — see [International processing](#international-processing) for what
this codebase does and does not control about that.

```
                    ┌─────────────────────────┐
                    │   PAYNORA application    │
                    │   (Next.js server-side)  │
                    └────────────┬─────────────┘
                                 │
        ┌────────────┬──────────┼──────────┬────────────┬─────────────┐
        │            │          │          │            │             │
        ▼            ▼          ▼          ▼            ▼             ▼
  ┌──────────┐  ┌─────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌────────────┐
  │PostgreSQL│  │AI       │ │Analytics│ │Email   │ │Telegram  │ │Alchemy /   │
  │(own DB)  │  │provider │ │(PostHog)│ │(SMTP)  │ │Bot API   │ │Anthropic   │
  └──────────┘  └─────────┘ └────────┘ └────────┘ └──────────┘ │Web Search  │
                                                                 └────────────┘
```

## PAYNORA → PostgreSQL

**Mandatory, always on.** Every model in `docs/privacy-data-inventory.md`
lives here. This is PAYNORA's own database — not a third party. No data
leaves PAYNORA's control at this step; it's the boundary every other flow
below reads from or writes to.

## PAYNORA → AI provider (OpenRouter / Mistral)

- **What leaves**: `AIRequest.input` — deterministically-prepared
  business facts (e.g. an invoice's amount/due date/days-overdue, per
  `DeterministicInvoiceContext`), never a raw database row. `AIRequest.system`
  is a fixed, operator-authored prompt constant, never customer free text.
- **Why**: drafting a reminder email's tone/summary, generating an
  Operator insight.
- **Provider**: `AI_PROVIDER` (`openrouter`/`mistral`) — see `src/server/ai/`.
- **Processing location**: whatever region OpenRouter/Mistral route the
  request to — not controlled by this codebase; see
  [International processing](#international-processing).
- **Mandatory?**: No. `AI_PROVIDER=none` (the default) disables this
  entirely — every AI-assisted feature has a deterministic, non-AI
  fallback and works identically without it.
- **Can be disabled?**: Yes, per-deployment, via `AI_PROVIDER=none`. No
  per-organization toggle exists for AI specifically (only for Analytics
  — see below); an organization on a deployment with AI enabled cannot
  individually opt out today. Documented gap, not a hidden default.

## PAYNORA → Analytics provider (PostHog)

- **What leaves**: an allowlisted event name, an internal distinct id
  (never an email/name), and sanitized properties — see
  `docs/privacy-data-inventory.md#analytics` for the exact redaction
  rule.
- **Why**: product usage signals (signup, invoice sent, payment
  recorded, wallet connected, ...) — see `ANALYTICS_EVENTS`.
- **Provider**: `ANALYTICS_PROVIDER` (`posthog`) — `src/server/analytics/`.
- **Processing location**: `POSTHOG_HOST` — defaults to PostHog's US
  cloud, configurable to `https://eu.i.posthog.com` for EU-hosted data
  residency.
- **Mandatory?**: No. `ANALYTICS_PROVIDER=none` (the default) is a real,
  harmless no-op.
- **Can be disabled?**: Yes, two independent levels — deployment-wide
  (`ANALYTICS_PROVIDER=none`) and per-organization (Settings → Privacy →
  Analytics, `Organization.analyticsEnabled`, Phase 15A).

## PAYNORA → Email provider (SMTP)

- **What leaves**: the exact `Communication.subject`/`body`/`recipient` a
  human already reviewed and approved — vendor-neutral SMTP-AUTH, works
  with any relay.
- **Why**: sending a payment reminder.
- **Provider**: `EMAIL_PROVIDER` (`smtp`) — `src/server/email/`.
- **Processing location**: whichever SMTP relay the deployment configures
  — operator's choice, not fixed by this codebase.
- **Mandatory?**: No. `EMAIL_PROVIDER=none` (the default) disables actual
  sending; drafting/preview/editing still work.
- **Can be disabled?**: Yes, deployment-wide only — no per-organization
  toggle (a business either uses PAYNORA's email channel or it doesn't,
  by choosing not to configure a channel/customer destination for it).

## PAYNORA → Telegram Bot API

- **What leaves**: the same reviewed `Communication` content, sent to the
  specific `Customer.telegramChatId` on file.
- **Why**: an alternate reminder channel for customers who prefer it.
- **Provider**: `MESSAGING_PROVIDER` (`telegram`) — `src/server/messaging/`.
- **Processing location**: Telegram's own infrastructure (a foreign,
  non-PAYNORA-controlled service by definition — see
  [International processing](#international-processing)).
- **Mandatory?**: No. Disabled unless a customer has a Telegram chat id
  configured and the deployment has `MESSAGING_PROVIDER=telegram` set.
- **Can be disabled?**: Yes, per-customer (never set a `telegramChatId`)
  and deployment-wide (`MESSAGING_PROVIDER=none`).

## PAYNORA → Alchemy

- **What leaves**: a wallet's public on-chain **address** (never a
  private key), an inbound webhook signature verification (Alchemy →
  PAYNORA, not the other direction), and JSON-RPC balance/transaction
  lookups.
- **Why**: monitoring a connected wallet for incoming crypto payments,
  reading balances.
- **Provider**: `WALLET_PROVIDER` (`alchemy`) — `src/server/wallet/`.
- **Processing location**: Alchemy's infrastructure; no PAYNORA-configurable
  EU-only processing guarantee exists in this integration layer today.
- **Mandatory?**: No. `WALLET_PROVIDER=none` (the default) disables crypto
  payments entirely.
- **Can be disabled?**: Yes, deployment-wide (`WALLET_PROVIDER=none`) and
  per-wallet (an organization simply never connects one).

## PAYNORA → Anthropic (Web Search)

- **What leaves**: a search query (`WebSearchRequest.query`) — whatever
  text the caller supplies to `tryWebSearch`/`decideAndSearch`.
- **Why**: answering a query that needs current/real-time information a
  static AI response can't provide.
- **Provider**: `WEB_SEARCH_PROVIDER` (`anthropic`) — `src/server/websearch/`.
  Deliberately separate from `AI_PROVIDER` — a different vendor
  relationship, different cost line, different failure mode.
- **Processing location**: Anthropic's infrastructure; no PAYNORA-configurable
  EU-only processing guarantee exists in this integration layer today.
- **Mandatory?**: No. `WEB_SEARCH_PROVIDER=none` (the default) disables
  the capability entirely; it also currently has no automatic trigger
  anywhere in the product (see `docs/production-integrations.md`), so
  even when enabled nothing calls it without a caller explicitly
  invoking `decideAndSearch`/`tryWebSearch`.
- **Can be disabled?**: Yes, deployment-wide only.

## International processing

No flow above carries a PAYNORA-enforced "stay in region X" guarantee
except PostHog's `POSTHOG_HOST` EU option. For every other provider, the
processing region is whatever that vendor's default routing does —
**`NEEDS LEGAL REVIEW`** for any deployment with a strict data-residency
requirement. This document states the technical fact (no enforced
region) rather than a compliance conclusion; see
`docs/privacy-policy.md#international-transfers`.

## Full data-flow list requested by the phase brief, verified

The brief's requested flow ("PAYNORA → PostgreSQL → AI provider →
Analytics provider → Email provider → Telegram → Alchemy → Anthropic Web
Search") describes six genuinely independent, optional-except-Postgres
flows fanning out from the same application — not a literal sequential
pipeline where each step feeds the next (an AI-drafted reminder's
*content* flows to Email/Telegram, but Analytics/Alchemy/Anthropic each
receive their own independent, narrower payload, not "whatever the AI
provider returned"). The diagram above reflects that actual fan-out
shape rather than forcing a false sequential dependency into the
documentation.
