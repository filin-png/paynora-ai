# Data Retention (Phase 15A)

What this codebase actually does with data over time, verified against
the code that writes and (sometimes) deletes it — not a target policy
this codebase has been configured to enforce. See
`docs/privacy-data-inventory.md` for what each category contains.

## Kept indefinitely, no automatic deletion

**Deliberate — audit, accounting, and legal requirements typically
require these to survive, and this codebase does not second-guess that
by inventing an automatic purge.**

| Data | Why it's never auto-deleted |
| --- | --- |
| `Invoice`, `Payment` | Financial records — the accounting/audit trail an organization needs regardless of any individual customer's or user's later preferences. |
| `Communication`, `DeliveryAttempt` | Proof of what was actually sent to a customer and when — the record a dispute or compliance question would need. |
| `WalletTransaction`, `CryptoPaymentRequest` | On-chain payment reconciliation history — same reasoning as `Payment`. |
| `ActivityEvent`, `BusinessEvent`, `OperatorInsight`, `ActionProposal` | The audit trail of what the system detected, proposed, and who approved it — see `SECURITY.md`'s trust-boundary chain. |
| `Customer`, `Invoice` (organization-owned records) | Business records belong to the organization, not to any individual — deleting a `User` never deletes these (see [User/account deletion](#user--account-deletion)). |

## Expires functionally, not physically purged

| Data | Behavior |
| --- | --- |
| `PasswordResetToken` | Carries `expiresAt`; a token past that timestamp is simply rejected at use-time (`src/server/auth/password-reset.ts`). Rows for a user's *other* unconsumed tokens are deleted the moment one reset succeeds (defense against a stale token being used after a successful reset) — but an expired, never-consumed token that was simply abandoned is **not** physically deleted by any scheduled job. |
| `OrganizationInvitation` | Same shape: `expiresAt` gates whether an invitation can still be accepted; no scheduled job removes expired rows. |

This is an honest gap, not a hidden design choice: neither table grows
without bound in any realistic deployment (both are low-volume,
per-user/per-organization actions), but a genuinely long-running
deployment would accumulate expired rows indefinitely. A future phase
could add a scheduled cleanup mirroring `RateLimitCounter`'s
`opportunisticCleanup` (below) — not implemented here because inventing
a retention *policy* (exactly how long to keep an expired-but-unconsumed
token) without a stated requirement would be guessing, not architecture.

## Actively, automatically purged

| Data | Retention | Mechanism |
| --- | --- | --- |
| `RateLimitCounter` | Rows older than 24 hours | `opportunisticCleanup()` (`src/server/rate-limit/service.ts`) — runs with roughly 1-in-200 probability on every rate-limit check, best-effort (failures are swallowed, never block the actual check). This is the table that transiently holds a signup attempt's **raw IP address** as its `key` column (scope `auth:signup:ip`) — see `docs/privacy-data-inventory.md#technical-data`. Not a guaranteed SLA (probabilistic, not a cron job), but in practice any given row is purged well within a few days of real traffic. |

## Not persisted at all (nothing to retain)

- AI prompts/requests (`AIRequest`) — built, sent, discarded per call; see `docs/privacy-data-inventory.md#ai-processing`.
- Web search queries — same; see `docs/privacy-data-inventory.md#web-intelligence`.
- Analytics event payloads — sent to PostHog, never stored in PAYNORA's own database.
- Provider telemetry (`recordProviderTelemetry`) — in-process only, never written to Postgres, never survives a process restart.

## Cookies

- Auth.js session cookie: lifetime matches the session strategy configured (`session: { strategy: "jwt" }`, `src/server/auth/config.ts`) — expires per Auth.js defaults, cleared on sign-out.
- `paynora_locale`: 1 year (`src/lib/i18n/actions.ts`).
- `paynora_cookie_consent`: 1 year (`src/lib/privacy/actions.ts`).

## User / account deletion

See `docs/account-recovery-and-invitations.md` for the existing account
model and `docs/privacy-policy.md#data-deletion` for the current,
honestly-scoped state of account-deletion tooling — as of this phase,
**no self-service "delete my account" flow exists**; see the "Not
implemented" list in that document.

## What this document is not

This is a factual description of current retention *behavior*, not a
retention *policy* an operator has committed to in a privacy policy or
contract. Setting a specific retention period (e.g. "we delete X after N
years") is a business/legal decision this codebase does not make on its
own — **`NEEDS LEGAL REVIEW`** before any specific retention period is
published as a commitment.
