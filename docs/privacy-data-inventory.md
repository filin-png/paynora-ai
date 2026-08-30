# Privacy Data Inventory (Phase 15A)

An honest inventory of what PAYNORA actually stores, derived directly
from `prisma/schema.prisma` and the domain code that writes to it — not
from what a typical SaaS "should" collect. Nothing below is listed
because it's common practice elsewhere; it's listed because a specific
model/column in this codebase actually persists it today. This document
is a factual inventory, not a legal instrument — see
`docs/privacy-policy.md` for the corresponding external-facing document
and its explicit "not a compliance certification" framing.

## Account data

| Data | Where | Notes |
| --- | --- | --- |
| Email address | `User.email` | Unique, used for sign-in and password reset. |
| Password | `User.passwordHash` | Bcrypt hash only — the plaintext password is never stored, logged, or transmitted to any third party. |
| Name | `User.name` | Optional, user-supplied. |
| Account timestamps | `User.createdAt`/`updatedAt` | |
| Password reset tokens | `PasswordResetToken` | Hashed token + expiry; see `docs/account-recovery-and-invitations.md`. |
| Organization invitations | `OrganizationInvitation` | Invited email, role, hashed token, inviter/acceptor user ids. |

## Organization data

| Data | Where | Notes |
| --- | --- | --- |
| Organization name/slug | `Organization.name`/`slug` | |
| Membership + role | `OrganizationMember` | Links a `User` to an `Organization` with `OWNER`/`MEMBER`. |
| Subscription/plan | `OrganizationSubscription` | PAYNORA's own billing state — see `docs/billing-entitlements.md`. |
| Automation preference | `Organization.automationEnabled`/`automationLastTickAt` | |
| Analytics preference | `Organization.analyticsEnabled` | Phase 15A — Settings → Privacy; see [Analytics](#analytics). |

## Financial / business data

| Data | Where | Notes |
| --- | --- | --- |
| Customer records | `Customer` | Name, optional email/phone/company/notes, optional Telegram chat id. |
| Invoices | `Invoice` | Amount (`amountMinor`, integer minor units — never a float), currency, dates, status, optional notes. |
| Payments | `Payment` | Amount, currency, recorded date, source (fiat/crypto). |
| Communications sent to customers | `Communication` | Full `subject`/`body`/`recipient` snapshot of every reminder — see [AI processing](#ai-processing) for the `aiGenerated` flag. Immutable once dispatch starts. |
| Delivery attempt history | `DeliveryAttempt` | Provider name, timestamps, failure category/message — never the message body itself (that lives on `Communication`). |
| Activity timeline | `ActivityEvent` | Human-readable `summary` + a small, deliberately non-sensitive `metadata` JSON blob (e.g. `{source, network, providerName}` — never a secret, never a full record) per event type. |
| Collections automation state | `CollectionPolicy`/`CollectionPolicyStep`/`CollectionSequence`/`CollectionStepExecution` | Policy configuration and per-invoice enrollment state — no customer free text beyond what's already in `Customer`/`Invoice`. |

## Wallet / blockchain data

| Data | Where | Notes |
| --- | --- | --- |
| Wallet address | `Wallet.address` | A public on-chain address — never a private key or seed phrase (asserted directly in tests, `wallets.test.ts`). |
| Wallet status/network | `Wallet.status`/`network` | |
| Crypto payment requests | `CryptoPaymentRequest` | Expected asset/amount tied to one invoice. |
| Wallet transactions | `WalletTransaction` | On-chain tx hash, amounts, confirmations, reconciliation outcome — all derived from a verified provider webhook or `inspectTransaction` call, never from an unverified client claim. |

## AI processing

| Data | Where | Notes |
| --- | --- | --- |
| AI-generated output | `Communication.body`/`subject` (when `aiGenerated=true`), `OperatorInsight.summary` | Only the final, schema-validated **output** is persisted. |
| AI provider name | `Communication.aiProvider`/`OperatorInsight.aiProvider` | e.g. `"openrouter"` — never a model version string with embedded config, never a credential. |
| AI prompts / raw requests | **Not persisted.** | `AIRequest` (`src/server/ai/types.ts`) is built, sent, and discarded per call — no prompt log table exists. The business data passed as `input` (e.g. invoice facts) is already persisted elsewhere (`Invoice`, `Customer`) independent of the AI call. |
| AI telemetry | `recordProviderTelemetry` (in-process, not persisted to Postgres) | `{category, provider, operation, result, durationMs, errorCode?, requestId?, organizationId?}` — no prompt, no completion, no secret. See `docs/integration-architecture.md#observability`. |

## Analytics

| Data | Where | Notes |
| --- | --- | --- |
| Event name + properties | Sent to PostHog only (not persisted in PAYNORA's own database) | Allowlisted event names only (`ANALYTICS_EVENTS`, `src/server/analytics/events.ts`); properties pass through `sanitizeProperties()`, which drops any key that looks sensitive (`secret`/`key`/`token`/`password`/`private`/`seed`/`mnemonic`/`auth`/`ssn`/`iban`/`card`/`signature`), before ever reaching the provider. |
| Distinct id | Sent to PostHog | `userId` if known, else `organizationId`, else `"system"` — an internal id, never an email or name. |
| IP address | **Not sent, geolocation explicitly disabled** | The PostHog adapter (`src/server/analytics/providers/posthog.ts`) makes a server-side `fetch` call — there is no browser-side PostHog script anywhere in this codebase, so no end customer's IP ever reaches PostHog through this path. `$geoip_disable: true` is set explicitly regardless (Phase 15A), so PostHog never attempts geolocation from whatever IP it does see (PAYNORA's own server). |
| Opt-out | `Organization.analyticsEnabled` (Phase 15A) | Real per-organization gate, checked before every event fires — see `src/server/analytics/events.ts#isAnalyticsAllowedForOrganization`. Deployment-wide switch remains `ANALYTICS_PROVIDER` (`none` = real no-op, nothing ever sent anywhere). |

## Web Intelligence

| Data | Where | Notes |
| --- | --- | --- |
| Search queries | Sent to Anthropic only (not persisted) | `WebSearchRequest.query` — whatever text the caller supplies; not currently wired to any UI that would let an end customer's free text reach it (see `docs/production-integrations.md#web-intelligence`'s documented gap — no automatic trigger exists yet). |
| Retrieved source metadata | Sent to Anthropic, returned to caller, not persisted | `WebSearchCitation {title, url, domain, citedText?}` — external web content, never persisted independently of whatever calls `tryWebSearch`/`decideAndSearch`. |
| Search telemetry | In-process only | Same `recordProviderTelemetry` shape as AI — no query content. |

## Technical data

| Data | Where | Notes |
| --- | --- | --- |
| IP address (auth rate limiting) | `RateLimitCounter.key` (scope `auth:signup:ip`/similar) | Raw client IP is the rate-limit key for sign-up abuse protection (`src/app/sign-up/actions.ts`) — see [Data retention](/docs/data-retention.md#rate-limit-counters) for how long these rows persist. Never linked to a `User` row; purely a counter keyed by IP + time window. |
| Request timestamps | Various `createdAt`/`updatedAt` columns throughout | Standard audit timestamps, not a separate request log. |
| Session cookie | Auth.js (NextAuth) default JWT session cookie | Framework-managed, httpOnly, not readable by client-side JavaScript. Strictly necessary for authentication. |
| Locale cookie | `paynora_locale` (`src/lib/i18n/config.ts`) | The only cookie this application's own code sets. Stores a UI language preference (`en`/`ru`) — no personal data, no tracking identifier. |
| No server access/request logs | — | This codebase has no request-logging middleware or log-aggregation integration; `console.warn`/`console.error` calls throughout are deliberately structured to never include a secret, prompt, or full financial payload (see `docs/integration-architecture.md#observability`), and whatever a hosting platform's own infrastructure logs (e.g. a PaaS's HTTP access log) is outside this codebase's control — documented as a gap in `docs/data-flows.md`. |

## What is explicitly never sent to any third party

Verified directly against the adapters that actually make network calls, not assumed:

- Passwords (plaintext or hash)
- Session tokens / auth cookies
- Wallet private keys or seed phrases (none exist anywhere in this codebase — there is no column, variable, or field that could hold one)
- Full `Customer`/`Invoice`/`Payment` records (only the specific fields each provider's adapter explicitly serializes — see `docs/data-flows.md`)
- Payment credentials (PAYNORA has no card/payment-credential storage of any kind — invoicing and reconciliation only)
