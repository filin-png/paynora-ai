# Subprocessors (Phase 15A)

Every third-party service PAYNORA's code can send data to, as configured
by `AI_PROVIDER`/`ANALYTICS_PROVIDER`/`EMAIL_PROVIDER`/`MESSAGING_PROVIDER`/
`WALLET_PROVIDER`/`WEB_SEARCH_PROVIDER` (`src/lib/env.ts`). Every field
below marked "not confirmed" is genuinely not confirmed — this document
does not invent a status. See `docs/data-flows.md` for what data each row
actually receives and `docs/production-integrations.md` for setup detail.

| Subprocessor | Purpose | Data category (see `docs/privacy-data-inventory.md`) | Region / hosting | DPA availability | Privacy policy | Production config status |
| --- | --- | --- | --- | --- | --- | --- |
| OpenRouter | AI text generation (reminder drafting, insights) | Deterministic business facts (no raw PII beyond what's already in the fact set) | Not confirmed — OpenRouter routes requests to varying underlying model providers; no fixed region | Not confirmed | [openrouter.ai/privacy](https://openrouter.ai/privacy) | Optional (`AI_PROVIDER=openrouter`) |
| Mistral AI | AI text generation (same as above, alternate/fallback provider) | Same as OpenRouter | Not confirmed | Not confirmed | [legal.mistral.ai/terms/privacy-policy](https://legal.mistral.ai/terms/privacy-policy) | Optional (`AI_PROVIDER=mistral`) |
| PostHog | Product analytics | Allowlisted event names, internal ids, sanitized properties — see `docs/privacy-data-inventory.md#analytics` | US cloud by default; EU option available (`POSTHOG_HOST=https://eu.i.posthog.com`) | Not confirmed for this deployment (PostHog publishes a standard DPA for customers — whether one is executed for a specific deployment is an operator action, not something this codebase can confirm) | [posthog.com/privacy](https://posthog.com/privacy) | Optional (`ANALYTICS_PROVIDER=posthog`) |
| Anthropic | Web search (Claude's `web_search` tool) | Search query text only — see `docs/privacy-data-inventory.md#web-intelligence` | Not confirmed | Not confirmed | [privacy.claude.com](https://privacy.claude.com/en/) | Optional (`WEB_SEARCH_PROVIDER=anthropic`) |
| Alchemy (Alchemy Insights, Inc.) | Wallet/blockchain: address monitoring, balance/transaction lookups, webhooks | Public on-chain wallet address only — never a private key or seed phrase | Not confirmed | Not confirmed | [legal.alchemy.com](https://legal.alchemy.com/) | Optional (`WALLET_PROVIDER=alchemy`) |
| SMTP relay (operator-chosen) | Transactional/reminder email delivery | `Communication.subject`/`body`/`recipient` for the specific email being sent | Whichever relay the deployment configures — operator's own choice, not fixed by this codebase | Depends entirely on the relay chosen — not something this codebase can state generically | N/A — vendor-neutral, no fixed provider | Optional (`EMAIL_PROVIDER=smtp`) |
| Telegram (Bot API) | Alternate reminder delivery channel | `Communication.subject`/`body` sent to a customer's `telegramChatId` | Not confirmed | Not confirmed — Telegram does not publish a standard enterprise DPA | [telegram.org/privacy](https://telegram.org/privacy) | Optional (`MESSAGING_PROVIDER=telegram`) |

## What this table is not

This is not a legal subprocessor registry maintained under an executed
Data Processing Agreement with PAYNORA's customers — it is a technical
inventory of what the code can call, generated from the actual provider
registry (`src/server/providers/registry.ts`). A real DPA-backed
subprocessor list requires the legal entity operating a given PAYNORA
deployment to actually execute agreements with each vendor it enables —
**`NEEDS LEGAL REVIEW`** before this table can be relied on as a
compliance artifact.

## Vendors this codebase deliberately does not use

Recognized-but-not-implemented providers (`gigachat`, `yandex` for AI;
`stripe`, `yookassa` for billing; `coinbase`, `privy` for wallets) send no
data anywhere — selecting one of these values fails loudly at startup
rather than silently routing data to an unbuilt integration. See
`docs/integration-architecture.md`.
