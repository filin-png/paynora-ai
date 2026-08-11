# Communications (Phase 4)

**Status: implemented.** This document describes what Phase 4 actually
built: the first real external side effect PAYNORA can produce — sending
an email — reached only through an explicit, reviewable, human-triggered
path. It does **not** add scheduling, automation, or any channel besides
email — see [Explicitly out of scope](#explicitly-out-of-scope-in-phase-4).
Phase 5 (`docs/collections-automation.md`) later added scheduling on top
of this, without changing anything described in this document —
`sendCommunication` and every guarantee below apply identically whether a
`Communication` was created by a human through the Action Center or by
the Phase 5 automation engine.

## The core rule: approval ≠ send

Phase 3 built `PENDING -> APPROVED`. Phase 4 does not change what
approving a proposal means — it still only changes a status. Sending is a
separate, later, explicit action:

```
PENDING -> APPROVED -> (prepare draft) -> DRAFT -> (explicit Send) -> SENT -> ActionProposal EXECUTED
```

Nothing in this codebase sends an email as a side effect of approval, of
running the Operator, or of any other action. The Action Center detail
page (`/app/[orgSlug]/actions/[proposalId]`) always shows the exact
recipient, subject, and body before a Send button becomes available, and
is explicit that clicking Send calls a real external provider.

## The pipeline, extended

```
Invoice overdue -> BusinessEvent -> OperatorInsight -> ActionProposal (Phase 3)
  -> [human approves] -> Communication draft -> [human reviews/edits] -> [human clicks Send]
  -> CommunicationService -> EmailProvider -> DeliveryAttempt -> Communication status -> ActionProposal EXECUTED (Phase 4)
```

| Stage | Code |
| --- | --- |
| Draft | `src/server/communications/draft.ts` — `prepareReminderCommunication` |
| Edit | `src/server/communications/editing.ts` — `updateCommunicationDraft` |
| Send | `src/server/communications/send.ts` — `sendCommunication` |
| Email transport | `src/server/email/*` — the AI-Gateway-shaped provider abstraction |

## Customer email

`Customer.email` already existed (Phase 2) — Phase 4 didn't add a column,
it tightened what's already there: `customerInputSchema`
(`src/server/ar/customers.ts`) now normalizes email the same way
`User.email` is (trim + lowercase, via the existing
`src/server/auth/email.ts#normalizeEmail`, reused rather than
reimplemented). A customer with no email can be created and invoiced
normally — Phase 4 only requires an email at the point a reminder is
actually drafted (`MissingCustomerEmailError` if absent), not before.

## Communication domain

`Communication` (one row per drafted reminder, `prisma/schema.prisma`):

- `actionProposalId` is `@unique` — a proposal can have at most one
  Communication ever, enforced at the database level, not just by
  application logic. `prepareReminderCommunication` is an
  ensure-idempotent function: a second call for the same proposal always
  returns the existing row.
- `recipient`/`subject`/`body` are **snapshotted**, not read live from
  `Customer` at send time. Once a communication leaves `DRAFT`, these
  fields are frozen — see [State machine](#state-machine) for how that's
  enforced, not just intended.
- `channel`/`purpose` exist as enums with exactly one member each
  (`EMAIL`, `PAYMENT_REMINDER`) — modeled as enums, not hardcoded, so a
  later phase adding a second channel or purpose is additive, not a
  breaking change to this table's shape.

`DeliveryAttempt` (one row per actual dispatch attempt — the initial send
and every retry each get their own row, never overwritten):

- `attemptNumber` + `@@unique([communicationId, attemptNumber])` — a full,
  ordered history survives any number of retries.
- `status`: `PENDING` (claimed, provider call not yet resolved) ->
  `SUCCESS` | `FAILED` | `UNKNOWN`. A row stuck at `PENDING` forever means
  the process died mid-attempt — see
  [Unknown outcomes](#unknown-outcomes).
- `failureCategory`/`failureMessage` are set only on `FAILED`/`UNKNOWN`.
  `CONFIGURATION` and `VALIDATION` are reserved enum values that Phase 4
  never actually reaches (see [Failure model](#failure-model)) — kept for
  a future phase that needs finer-grained retry policy, the same
  forward-compatible-schema pattern Phase 3 used for
  `ActionProposalStatus.FAILED`.
- Never stores an API key, credential, or the full provider response —
  only `provider` (a name), `providerMessageId`, and a short
  `failureMessage`.

## State machine

```
DRAFT --Send--> SENDING --success--> SENT
DRAFT --Send--> SENDING --definite rejection--> FAILED
DRAFT --Send--> SENDING --timeout/unrecognized error--> UNCERTAIN
FAILED --Send (retry)--> SENDING --...--> (same three outcomes)
UNCERTAIN --Send + acknowledgeUncertainRisk--> SENDING --...--> (same three outcomes)
```

- `SENT` is terminal. Nothing moves a `SENT` communication back to
  `DRAFT` or anywhere else — there is no "unsend."
- Editing (`updateCommunicationDraft`) only succeeds while `DRAFT`.
- A communication a user is actually looking at that reads `SENDING` is,
  by construction, stuck: a live in-flight request blocks the Server
  Action that would return and let the page re-render, so any `SENDING`
  a browser can observe reflects a request that never got to record its
  outcome (a crash, in practice). The Action Center therefore renders
  `SENDING` identically to `UNCERTAIN` — see
  [Unknown outcomes](#unknown-outcomes).

Every transition is enforced by `src/server/communications/send.ts` and
`editing.ts` as an **atomic conditional database update**
(`UPDATE ... WHERE status = ...`), not a separate read-then-write — see
[Concurrency](#concurrency).

## Delivery semantics

### Why a DB transaction can't wrap the provider call

The tempting-looking approach —

```
BEGIN
provider.send()
UPDATE communications SET status = 'SENT'
COMMIT
```

— is unsafe: if the process crashes after `provider.send()` returns
success but before `COMMIT`, the provider has already sent the email but
the database still thinks it hasn't. A naive retry (either automatic or a
confused user clicking Send again) would then send a **second, real
duplicate email** to the customer. A DB transaction cannot make an
external HTTP call atomic with a local write — the two systems don't
share a commit protocol.

### What Phase 4 does instead

`sendCommunication` is two-phase (see the full walkthrough in
`src/server/communications/send.ts`'s docstring):

1. **Claim**, in one DB transaction: atomically flip
   `DRAFT`/`FAILED`[/`UNCERTAIN` with explicit acknowledgement] ->
   `SENDING`, and create a `PENDING` `DeliveryAttempt`. This transaction
   commits *before* any external call is made.
2. **Dispatch**, outside any transaction: call the `EmailProvider`.
3. **Record the outcome**, in a second DB transaction, after the provider
   call returns (or fails).

This does not achieve exactly-once delivery — nothing can, without
provider-side idempotency support most transactional email
services/relays don't offer (see
[Provider abstraction](#provider-abstraction)) or an outbox/reconciliation
process (explicitly out of scope for Phase 4 — no schedulers). What it
achieves instead, and states plainly rather than overclaiming:

- **At most one *user-triggered* dispatch per claim.** Two concurrent
  Send clicks, or a Send racing a retry, can never both call the
  provider — the claim step's atomic conditional update guarantees
  exactly one caller wins (see [Concurrency](#concurrency)).
- **A crash between provider success and recording it is a known,
  accepted gap**, surfaced honestly as a stuck `SENDING` (treated as
  uncertain) rather than silently retried or silently declared sent.

### Unknown outcomes

Not every provider failure means "not delivered." A timeout, a network
error, or any exception the provider adapter didn't explicitly recognize
as a definite rejection is **not** treated as a confirmed failure — it's
recorded as `UNKNOWN` (`DeliveryAttempt`) / `UNCERTAIN` (`Communication`),
and the Action Center says exactly that:

> Delivery status uncertain. Do not resend automatically.

Resending from `UNCERTAIN` requires an explicit
`acknowledgeUncertainRisk: true` — there is no other path back to
`SENDING` from `UNCERTAIN`. The UI's "Resend anyway (may send a
duplicate)" button is deliberately separate from the normal Send/Retry
button and requires a confirmation dialog before submitting — see
`src/app/app/[orgSlug]/actions/[proposalId]/send-form.tsx`. This is a
manual, informed decision, never an automatic one, per the project's
explicit instruction: an ambiguous timeout is never blindly retried as if
the email definitely wasn't sent.

## Failure model

`src/server/email/errors.ts` normalizes every `EmailProvider` failure into
one of four types, and `sendCommunication` treats exactly one of them as a
confirmed failure:

| Error | Meaning | `Communication` outcome |
| --- | --- | --- |
| `EmailDisabledError` | `EMAIL_PROVIDER=none` | Send unavailable; no state change, no `DeliveryAttempt` created |
| `EmailConfigurationError` | Provider selected but misconfigured (missing sender/SMTP credentials) | Send unavailable; no state change, no `DeliveryAttempt` created |
| `EmailProviderRejectedError` | The provider is certain the message was not accepted | `FAILED` |
| Anything else (`EmailTimeoutError`, `EmailProviderUnknownError`, or any unrecognized exception) | Outcome not known | `UNCERTAIN` |

Configuration/disabled failures are checked **before** the claim step, so
they never create a `DeliveryAttempt` or move a communication out of
`DRAFT` — see [Sender safety](#sender-safety). No raw exception or stack
trace is ever shown to the user; `sendCommunicationAction`
(`src/app/app/[orgSlug]/actions/[proposalId]/actions.ts`) surfaces only
the error's message.

## Retry policy

- `FAILED -> SENDING` (retry) needs no special flag — a definite
  rejection means nothing was sent, so retrying is always safe from a
  duplicate-delivery standpoint. Each retry is a **new**
  `DeliveryAttempt` row; the failed one is never deleted or overwritten.
- `UNCERTAIN -> SENDING` (resend) needs `acknowledgeUncertainRisk: true`
  — see [Unknown outcomes](#unknown-outcomes).
- There is no automatic/scheduled retry of anything. A human clicks Retry
  or Resend, or doesn't.

## ActionProposal integration

A `Communication` can only ever be prepared from an `ActionProposal` that
is `type: SEND_PAYMENT_REMINDER` and `status: APPROVED`
(`InvalidActionProposalForCommunicationError` otherwise) —
`src/server/communications/draft.ts`. Once a `Communication` exists for a
proposal (`@unique` on `actionProposalId`), `prepareReminderCommunication`
always returns it unchanged on subsequent calls regardless of the
proposal's *current* status — including `EXECUTED` — so re-visiting an
already-sent reminder's page never errors or tries to draft a second one.

`ActionProposal.status` moves to `EXECUTED` in exactly one place —
`finalizeSuccess` in `src/server/communications/send.ts` — and only after
a *confirmed successful* send, via the same atomic conditional-update
technique as everything else here (`WHERE status = 'APPROVED'`). A
failed or uncertain send leaves the proposal `APPROVED`: failure/
uncertainty is state that belongs to the `Communication` and its
`DeliveryAttempt` history (both retryable), not to the proposal, which is
why `ActionProposalStatus.FAILED` is still never set by any Phase 4 code
— see `docs/operator-foundation.md#approval-workflow`. Approving a
proposal (Phase 3) is completely untouched by any of this — it still only
ever changes `PENDING` to `APPROVED`.

## Concurrency

Every race below is closed by the same technique Phase 3 introduced for
`ActionProposal` approval (`src/server/operator/approval.ts`): an atomic
conditional `UPDATE ... WHERE status = <expected>` inside a transaction.
Postgres locks the target row while evaluating that `WHERE` clause, so
concurrent transactions touching the same row serialize; the loser's
`WHERE` is re-evaluated against the winner's already-committed state
(Postgres's default READ COMMITTED "EvalPlanQual" behavior) and matches
zero rows instead of overwriting anything.

- **Send vs. Send** (a double-click, or two concurrent requests): only one
  claim succeeds; the other gets `InvalidCommunicationTransitionError`
  before any provider call happens. Proven with a real concurrent test
  firing two `sendCommunication` calls at a communication and asserting
  the `EmailProvider`'s `send` was invoked exactly once
  (`src/server/communications/send.test.ts`).
- **Send vs. Edit**: `updateCommunicationDraft`'s own conditional update
  (`WHERE status = 'DRAFT'`) means an edit that loses the race to a
  concurrent Send's claim is rejected, not silently applied to content
  that's already been (or is being) dispatched. Whichever content was
  actually persisted at claim time is exactly what gets sent — proven by
  a test that races the two and asserts the provider always received
  content matching whatever ended up persisted, regardless of which
  operation won.
- **Retry vs. Retry**: identical mechanism as Send vs. Send — `FAILED`
  only accepts one claimant.

## Provider abstraction

```
CommunicationService (src/server/communications/send.ts)
  -> Email Gateway (src/server/email/gateway.ts) — timeout + error normalization
  -> EmailProvider (src/server/email/providers/*.ts)
```

`EmailProvider` (`src/server/email/types.ts`) is one method:
`send(message): Promise<EmailSendResult>`. No branch in the communications
domain inspects a provider name — `sendCommunication` receives an
`EmailProvider` instance (normally from
`resolveEmailProvider()`, `src/server/email/service.ts`) and only ever
calls its `.send()`.

**SMTP, not a vendor SDK.** `src/server/email/providers/smtp.ts`
implements `EmailProvider` over `nodemailer`, configured via
`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_SECURE`. SMTP
itself is the swappable boundary: a self-hosted mail server, a
Russia-accessible provider, or a foreign one all work identically —
switching is a configuration change, not a code change. This was chosen
over a vendor-specific REST API (Resend, Postmark, SendGrid, ...)
specifically to avoid picking one foreign paid vendor as a hard
dependency, consistent with `docs/provider-strategy.md`'s Russia-
accessibility constraint. No account was created and no API key was
invented for this project — `EMAIL_PROVIDER` defaults to `"none"`, and
the app boots, and every non-sending feature (drafting, preview, editing)
works, with zero email configuration.

**Fake, test-only.** `src/server/email/providers/fake.ts` is a
deterministic in-memory `EmailProvider` (`success`/`rejected`/`error`/
`hang` behaviors) used only by tests, via a test-only dependency
injection point (`sendCommunication`'s `options.provider`) — production
code always goes through `resolveEmailProvider()`. No real vendor SDK and
no network call are involved anywhere in the test suite or CI.

## Sender safety

- **From is never user input.** `PAYNORA_EMAIL_FROM` is a server
  environment variable; there is no form field anywhere that sets a
  per-message sender. `getSenderAddress()` (`src/server/email/service.ts`)
  is the only place a `from` address comes from.
- **Recipient is never user input either.** `Communication.recipient` is
  set once, server-side, from `Customer.email`, at draft-creation time —
  the edit form (`src/app/app/[orgSlug]/actions/[proposalId]/edit-form.tsx`)
  only exposes `subject`/`body` fields. There is no way to submit an
  arbitrary recipient through the Send form — Phase 4 does not become a
  general-purpose email relay.
- **Configuration is checked before any state change.** `resolveEmailProvider()`
  throws `EmailDisabledError`/`EmailConfigurationError` before
  `sendCommunication` claims anything — a misconfigured deployment can
  never leave a communication stuck mid-send because of its own
  misconfiguration.

## Email security

- **Header injection**: `updateCommunicationDraft`'s Zod schema
  (`src/server/communications/editing.ts`) rejects a subject containing a
  CR or LF outright — a crafted subject can't inject additional headers
  (`Bcc:`, a forged `From:`, ...). Tested directly.
- **Oversized input**: subject capped at 200 characters, body at 10,000 —
  both a defense against abuse and a sane email length in practice.
- **Plain text only.** Phase 4 sends `text/plain` — no HTML rendering, no
  HTML injection surface, no email-designer UI to build or secure.
- **Provider error leakage**: `DeliveryAttempt.failureMessage` is a short
  string from the provider; nothing that could be a credential or secret
  is ever stored there or shown in the UI — there's no code path by which
  one could be, since `EmailProvider` implementations never receive
  credentials through the message they're asked to send.
- **Arbitrary recipient relay**: see [Sender safety](#sender-safety) —
  structurally impossible through this feature's Server Actions, not just
  policy.

## AI and email wording

Uses the Phase 3 AI Gateway architecture unchanged (`src/server/ai/*`):
`src/server/communications/ai-context.ts` builds a request the same
prompt-injection-safe way `src/server/operator/ai-context.ts` does —
`system` is a fixed constant, `input` is the deterministic invoice/
customer context (which may include customer-authored free text), never
concatenated together. The system prompt additionally instructs the model
never to alter the amount, invoice number, or recipient — but the actual
guarantee is structural, not the wording: **the AI response schema
(`reminderEmailOutputSchema`) has exactly two fields, `subject` and
`body`.** There is no field an AI response could populate that changes
who the email goes to, what invoice it's about, or how much it says is
owed — those are resolved entirely server-side, before the AI is ever
called, from `Customer.email` and the deterministic AR domain.

`buildDeterministicReminderEmail` (`src/server/communications/templates.ts`)
is the always-available fallback, used whenever AI is disabled (the
default), fails, times out, or returns output that fails schema
validation — `tryGenerateStructured` never throws, so this is a plain
`null` check, not exception handling. Tested with the prompt-injection
scenario from Phase 3 adapted for email
(`src/server/communications/ai-context.test.ts`).

## Audit trail

Reuses the existing `ActivityEvent` table (Phase 2/3) rather than a
parallel mechanism — six new `ActivityEventType` values:
`COMMUNICATION_PREPARED`, `COMMUNICATION_EDITED`,
`COMMUNICATION_SEND_ATTEMPTED` (covers both the initial send and every
retry — the attempt number is in the event's `metadata`, not a separate
type per attempt), `COMMUNICATION_SENT`, `COMMUNICATION_SEND_FAILED`
(covers both `FAILED` and `UNCERTAIN` terminal outcomes, distinguished by
`metadata.outcome` — again one type, not two, to avoid enum sprawl for a
distinction that's already in the row's own status), and
`ACTION_PROPOSAL_EXECUTED`. Metadata never includes the email body or
provider credentials — only ids, counts, and short category labels.

## Action Center UI

`/app/[orgSlug]/actions/[proposalId]` — reachable from an `APPROVED`
proposal's "Approved — review & send" link on the main Action Center
list:

- No `Communication` yet -> "Prepare reminder email" button.
- `DRAFT` -> editable subject/body form ("Save changes") plus a "Send
  email" button, with the recipient/invoice/outstanding amount shown
  above.
- `FAILED` -> the failure reason, plus a "Retry" button.
- `SENDING`/`UNCERTAIN` -> "Delivery status uncertain. Do not resend
  automatically." plus a separately-labeled, confirmation-gated "Resend
  anyway (may send a duplicate)" button.
- `SENT` -> "Sent [date/time]", the final subject/body (read-only), and
  the full delivery attempt history.

The main Action Center list (`/app/[orgSlug]/actions`) shows `EXECUTED`
proposals as "Sent" alongside `APPROVED` ("review & send") and
`DISMISSED` — nothing disappears from view just because it reached a
terminal state.

## Explicitly out of scope in Phase 4

- Telegram, SMS, WhatsApp — `CommunicationChannel` has one member
  (`EMAIL`) on purpose.
- Any scheduler, cron job, or background queue — "Send" is a synchronous,
  human-triggered Server Action, exactly like "Run Operator" in Phase 3.
  **Built in Phase 5** (`runAutomationTick`), which calls this exact
  `sendCommunication` function unchanged — see
  `docs/collections-automation.md#auto-send`.
- Scheduled/automatic reminder sequences (e.g. due date -> +3d -> +7d) —
  **built in Phase 5** as `CollectionPolicy`/`CollectionSequence`, see
  `docs/collections-automation.md`.
- A production, paid vendor account — no API key was created or invented;
  `EMAIL_PROVIDER=none` is the default and the only value exercised in
  tests/CI.
- Bulk/marketing email, newsletters, arbitrary-recipient messaging.
- Inbound email processing (replies, bounces-as-events, unsubscribes).
- HTML email design.
- An outbox/reconciliation process for the crash-after-provider-success
  gap described in [Delivery semantics](#delivery-semantics) — documented
  as a known limitation, not solved.
