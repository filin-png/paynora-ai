# Security

PAYNORA handles financial data (invoices, payments, customer collection
communication) for multiple tenants. Security is a baseline requirement,
not a later add-on.

## Trust boundary chain (Operator / AI, Phase 3+)

Every AI-assisted feature in this codebase — currently just the Operator's
insight wording — flows through one fixed chain, and each link only trusts
the one before it after an explicit check:

```
User
  -> Server-side authorization (requireOrganizationMembershipForPage)
  -> Tenant context (organizationId re-verified against the DB, never trusted from a cookie or client value)
  -> Deterministic business logic (src/server/ar/*, src/server/operator/events.ts, insights.ts, proposals.ts)
  -> AI boundary (src/server/ai/service.ts — optional, never required, never trusted with authorization)
  -> Validated structured output (Zod schema, src/server/ai/gateway.ts — invalid output is discarded, not partially used)
  -> Allowlisted ActionProposal (src/server/operator/proposals.ts — server-side ActionType allowlist; AI is never asked for and never validated to produce an action type)
  -> Human approval (src/server/operator/approval.ts — PENDING -> APPROVED/DISMISSED only; approving never executes anything in Phase 3)
```

**AI is an untrusted, probabilistic subsystem. Its output is never treated
as authorization, and it is never the source of truth for any financial
fact** (outstanding amount, paid amount, currency, due date, days overdue,
invoice status, or tenant/customer ownership) — those are always read from
the deterministic Phase 2 AR domain and only ever *passed to* the AI layer
as prepared, structured context, never derived *from* an AI response. The
one thing an AI response is allowed to influence is display text (an
insight's summary, or an email's subject/body wording) — validated against
a fixed schema before use, and always with a deterministic fallback when
AI is disabled, misconfigured, times out, or fails. See
`docs/operator-foundation.md` and `docs/ai-architecture.md` for the full
design.

## Trust boundary chain (Communications / Email, Phase 4)

The chain above ends at human approval. Phase 4 extends it one more step
— from an approved proposal to a real external side effect — with the
same "trust nothing further downstream than necessary" discipline:

```
ActionProposal (APPROVED, SEND_PAYMENT_REMINDER only)
  -> Draft preparation (src/server/communications/draft.ts — deterministic recipient/facts; AI, if used, only affects wording)
  -> Human review/edit (src/server/communications/editing.ts — subject/body only; recipient/invoice/customer/proposal are never editable through this path)
  -> Explicit Send (a distinct user action — approving never reaches this step by itself)
  -> Email boundary (src/server/email/service.ts — resolveEmailProvider(); throws before any state change if unconfigured)
  -> Provider dispatch (src/server/email/gateway.ts — timeout + normalized outcome: success / definite rejection / unknown)
  -> Confirmed-success-only proposal execution (src/server/communications/send.ts — ActionProposal -> EXECUTED only on a confirmed SUCCESS, never on FAILED or UNCERTAIN)
```

**Sending is never implicit.** No code path sends an email as a
consequence of approval, of running the Operator, of AI output, or of any
other action — only an explicit call to `sendCommunication`, triggered by
a human clicking Send in the UI, ever invokes an `EmailProvider`. See
`docs/communications.md` for the full design, including exactly why a
naive "wrap the provider call in a DB transaction" approach is unsafe and
what Phase 4 does instead.

## Trust boundary chain (Collections Automation, Phase 5)

Phase 5 adds a *trigger* upstream of the Phase 3/4 chains above — a
scheduled tick — without adding a second path into either chain:

```
Scheduler (any vendor, or a dev-only manual trigger)
  -> Internal auth boundary (src/server/collections/scheduler-auth.ts — AUTOMATION_CRON_SECRET, timing-safe compare; the dev trigger instead re-verifies OWNER role)
  -> runAutomationTick (src/server/collections/engine.ts — never trusts a client-supplied `now` or tenant id)
  -> Fresh eligibility re-check (live financials, sequence/policy state, prior-communication safety — re-derived every tick, never cached)
  -> [enters the Phase 3 chain above unchanged: BusinessEvent -> OperatorInsight -> ActionProposal]
  -> APPROVAL_REQUIRED: stops here, a human takes it from ActionProposal onward exactly as in Phase 3/4
  -> AUTO_SEND (OWNER opt-in only): approveActionProposal + sendCommunication, i.e. re-enters the Phase 4 chain above unchanged, as the OWNER who explicitly authorized it
```

**A schedule is never authorization to send.** Every tick re-derives
whether an invoice still needs action from the live database — an
invoice that was overdue an hour ago and is paid now gets zero
communication, unconditionally. **AUTO_SEND never bypasses Phase 3/4**:
it calls the exact same `approveActionProposal`/`sendCommunication`
functions a human's click would call, with a real, audited acting user
(the OWNER who explicitly enabled `AUTO_SEND`, recorded at the moment
they did so) — there is no direct `EmailProvider`/`nodemailer` call
anywhere in `src/server/collections/`. See `docs/collections-automation.md`
for the full design, including the concurrency and payment-race reasoning.

## Trust boundary chain (Integration & Provider Foundation, Phase 6)

Phase 6 adds three new provider categories (`MessagingProvider`,
`BillingProvider`, and extended `AIProvider` routing) but adds **no new
entry point into the trust boundary chains above** — no domain code calls
`MessagingProvider` yet, and `BillingProvider` is a verification/
normalization boundary only, with no writer of financial state behind it.
The chain that does apply, for every gateway (AI/Email/Messaging alike):

```
Provider adapter (src/server/{ai,email,messaging}/providers/*.ts)
  -> Gateway (runAIGeneration / dispatchEmail / dispatchMessage — timeout +
     normalized errors + secret-free telemetry, the one place a provider
     is actually invoked, regardless of caller)
  -> Service (resolve*Provider() — the one place that knows which vendor
     is configured; throws *DisabledError/*NotImplementedError before any
     call, never silently no-ops)
  -> Domain code (only Email has a real caller today —
     src/server/communications/send.ts; Messaging and Billing have none)
```

**A `BillingProvider` must never itself change financial state.**
`verifyAndParseWebhook` (`src/server/billing/types.ts`) only verifies
authenticity and normalizes a webhook into a `NormalizedSubscriptionEvent`
— it throws `BillingWebhookVerificationError` on a failed signature check
rather than returning a best-guess result, so a forged webhook can never
reach domain code labeled as legitimate. There is no domain code that
applies one yet (Phase 10, per `ROADMAP.md`); when that domain exists, it
is responsible for its own idempotency check against
`eventIdentity.eventId` before applying anything.

**A health check must never perform a dangerous side effect.**
`ProviderHealthStatus` (`src/server/providers/registry.ts`) is derived
entirely from configuration — no code path in this phase sends a real
email, spends a paid AI call, or posts a real Telegram message just to
determine health. `DEGRADED`/`DOWN` are defined but never produced by any
code today, precisely so a future live health-check mechanism (which
would need its own explicit side-effect budget) can be added without a
breaking type change, not by accident.

**Deployment profile is never a security boundary.** `DEPLOYMENT_PROFILE`
is descriptive metadata only (see
`docs/integration-architecture.md#deployment-profiles`) — selecting a
vendor outside its profile's recommendation is never rejected, so nothing
in this phase should be read as enforcing which vendors a given
organization "is allowed" to use.

See `docs/integration-architecture.md` for the full design, including why
each provider category stopped where it did.

## Trust boundary chain (Production Communications & AI, Phase 8)

Phase 8 gives `MessagingProvider` (Telegram) its first real domain caller
and hardens the AI/Email gateways for production. The chain from Phase 6
is unchanged in shape — every provider still flows
`adapter -> Gateway -> Service -> domain code` — but two new boundaries
are load-bearing now that Telegram is actually reachable:

**A Telegram chat id is never PAYNORA identity.** `communication.recipient`
(the chat id passed to `MessagingProvider.send`) is set exactly once, at
draft time, by `resolveCommunicationDestination`
(`src/server/communications/channel.ts`) reading `Customer.telegramChatId`
— a tenant-scoped, server-side domain read. No code path accepts a chat
id, organization id, or invoice id from a client request and uses it to
select where a message goes or which tenant it belongs to;
`sendCommunication` re-derives everything from `organizationId` +
`communicationId`, both filtered by `organizationId` on every query (see
`src/server/communications/send.ts`), so a guessed or forged
`communicationId` from another organization resolves to "not found," never
another tenant's data.

**Channel selection has no silent fallback.** `resolveCommunicationDestination`
auto-picks a channel only when exactly one destination is configured, and
returns `blocked: true` with a human-readable reason otherwise (e.g. both
Email and Telegram configured with no explicit preference) — there is no
code path where "email failed" or "email missing" causes a silent retry
on Telegram, or vice versa. See `src/server/communications/channel.test.ts`
for the adversarial cases (both configured, neither configured, explicit
preference pointing at a destination that isn't actually set).

**AI is structurally never authoritative for a financial or identity
value.** `prepareReminderCommunication` (`src/server/communications/draft.ts`)
persists `recipient`, `channel`, `customerId`, `invoiceId`, and
`organizationId` from server-side domain reads only; the AI's structured
output (`ReminderEmailAIOutput`, `src/server/communications/ai-context.ts`)
can populate `subject`/`body` alone — its Zod schema has no field capable
of setting who a message goes to, how much is owed, or whether sending is
authorized. This is unchanged from Phase 3's Operator insight schema
(`tone`/`summary` only), reverified here for the communications path.

**A timed-out request is actually cancelled, not just abandoned.**
`runAIGeneration` and `dispatchMessage` (`src/server/ai/gateway.ts`,
`src/server/messaging/gateway.ts`) create a real `AbortController` per
call and abort it when the timeout fires; both real HTTP adapters forward
`signal` into `fetch`. SMTP (socket-based, no `AbortSignal`) instead bounds
every phase via nodemailer's `connectionTimeout`/`greetingTimeout`/
`socketTimeout`. Either way, a timed-out attempt never keeps consuming a
real connection in the background after this codebase has moved on to
recording `UNCERTAIN` — see
[Idempotency for money-adjacent automation](#principles) below for what
happens to that `UNCERTAIN` state.

See `docs/communications.md` and `docs/integration-architecture.md#ai-routing`
for the full design.

## Principles

- **Validate at the boundary.** All external input — HTTP requests, AI
  provider output, environment variables — is validated with Zod before it
  reaches business logic. AI output is treated as untrusted external
  output, the same as user input.
- **Authorization is server-side, always.** The UI hiding a control is
  never treated as access control. Every query and mutation checks that
  the acting user is authorized for the organization the data belongs to.
- **Tenant isolation is a hard requirement.** Organization A must never be
  able to read or modify Organization B's data, under any code path.
  Automated tests cover every tenant-owned resource — memberships (Phase 1)
  and customers/invoices/payments/activity (Phase 2).
- **Secrets never enter source control.** `.env*` files are gitignored
  except `.env.example`, which documents variable names only — no real
  values. See `.env.example` for the current (empty) list.
- **Prompt-injection awareness.** Customer email/message content fed into
  AI features is untrusted input, never an instruction. Every AI request
  (`AIRequest` in `src/server/ai/types.ts`) structurally separates fixed,
  operator-authored instructions (`system`) from business data
  (`input`) — business data, including customer-authored free text, is
  never concatenated into `system`. Tested against a concrete injection
  attempt in `src/server/operator/ai-context.test.ts`; see
  `docs/operator-foundation.md#prompt-injection-defense`.
- **Idempotency for money-adjacent automation.** `sendCommunication`
  (`src/server/communications/send.ts`) is designed to be safely retried
  — an atomic conditional DB claim ensures a double-click or two
  concurrent requests can never both dispatch to the email provider; see
  `docs/communications.md#concurrency` for the proof (real concurrent
  tests, not just the design intent). Phase 5's `runAutomationTick` is
  idempotent the same way, at every stage: enrollment
  (`@@unique([organizationId, invoiceId])`), step claiming
  (`@@unique([sequenceId, stepId])`), and the reused Phase 3/4 creation
  functions — a repeated tick with the same `now` never duplicates
  anything, proven with real repeated-call tests.
- **No sensitive data in logs.** Structured logging (introduced when
  observability infrastructure is added) excludes credentials, tokens, and
  full customer payment details.

## Current status (Phase 8)

- **A Telegram chat id is never treated as PAYNORA identity or
  authorization.** See
  [Trust boundary chain (Production Communications & AI)](#trust-boundary-chain-production-communications--ai-phase-8)
  above — `communication.recipient` is always a server-side read of
  `Customer.telegramChatId`, filtered by `organizationId` on every query;
  no request path accepts a chat id, org id, or invoice id from the client
  and uses it to select a destination or tenant.
- **Channel selection never silently substitutes one channel for
  another.** `resolveCommunicationDestination`
  (`src/server/communications/channel.ts`) either auto-resolves an
  unambiguous single destination or returns `blocked: true` with a reason
  — there is no "email failed, try Telegram instead" code path. Tested in
  `src/server/communications/channel.test.ts` and
  `draft.test.ts` (ambiguous/missing-destination cases).
- **AI cannot set who a message goes to, how much is owed, or whether
  sending is authorized** — only `subject`/`body` free text. See
  [Trust boundary chain (Production Communications & AI)](#trust-boundary-chain-production-communications--ai-phase-8)
  above.
- **AI routing's retryable/non-retryable policy is explicit and tested.**
  Every `AIProvider` failure kind (timeout, provider/rate-limit error,
  invalid configuration, invalid output failing schema validation) is
  fallback-eligible — there is no non-retryable category, because
  "fallback" here always means a structurally different vendor and
  credential, never a resubmission to the same one. See
  `docs/integration-architecture.md#ai-routing` and
  `src/server/ai/service.test.ts`'s dedicated policy test.
- **Timeouts cancel the real request, not just a local promise.**
  `runAIGeneration`/`dispatchMessage` create and abort a real
  `AbortController` on timeout, forwarded into `fetch` by both real HTTP
  adapters; SMTP bounds every socket phase via nodemailer's
  `connectionTimeout`/`greetingTimeout`/`socketTimeout` instead (no
  `AbortSignal` applies to a socket protocol). Proven with tests that
  assert the signal a mocked provider received was actually aborted, not
  merely present — `src/server/ai/gateway.test.ts`,
  `src/server/messaging/gateway.test.ts`.
- **Audit trail records who triggered a send.** `sendCommunication`'s
  `actorSource` (`"USER"` | `"AUTOMATION"`) is recorded on the
  `COMMUNICATION_SEND_ATTEMPTED`/`COMMUNICATION_SENT` `ActivityEvent`'s
  `metadata.source` — a real gap found and fixed during this phase's
  audit: Collections Automation's `executeAutoSend` previously omitted
  this option entirely, silently defaulting to `"USER"` for an automated
  send.
- **Idempotency for Telegram inherits Email's guarantees, not a
  reimplementation of them.** `dispatchByChannel`
  (`src/server/communications/send.ts`) branches on channel only inside
  the same atomic claim/dispatch/finalize state machine Phase 4
  established — proven with a Telegram-specific concurrent double-send
  test (`send.test.ts`), not merely asserted by code-reading.
- **The dev-only live smoke-test CLI cannot run in CI or print a secret.**
  `scripts/live-smoke-test.ts` refuses to run when `CI` or `VITEST` is set,
  requires `--confirm` before any real vendor call, takes no default
  recipient, and only ever logs a normalized provider name/result — never
  a raw response, header, or credential. Not part of `npm test` or any CI
  workflow; see `docs/integration-architecture.md#live-smoke-test`.
- **Zero new credentials required to run the app or its test suite** —
  `TELEGRAM_BOT_TOKEN` (already Phase 6) and the existing AI/SMTP vars
  remain fully optional; the full test suite (416 tests) and CI make zero
  real network calls to OpenRouter, Mistral, SMTP, or Telegram.

See `docs/communications.md` and `docs/integration-architecture.md` for
the full design.

## Organization deletion: irreversible cascade, no product UI path (Phase 9)

Every business-data table's `organizationId` foreign key is
`onDelete: Cascade` (`prisma/schema.prisma`) — deleting an `Organization`
row deletes every `Customer`, `Invoice`, `Payment`, `ActivityEvent`,
`Communication`, `DeliveryAttempt`, `CollectionPolicy`,
`CollectionSequence`, and every other tenant-scoped record belonging to
it, in one irreversible operation. There is deliberately no product code
path that deletes an `Organization` — no Server Action, no admin UI —
so this risk is currently theoretical, reachable only by someone with
direct database access (e.g. `psql`) or a future feature that isn't
built yet. Documented here specifically so that risk isn't invisible:
anyone building an "delete organization" feature, or operating the
database directly, needs to know a single `DELETE FROM organizations
WHERE id = ...` takes every one of that organization's invoices and
payment history with it, permanently, with no soft-delete or recovery
path. See DEPLOYMENT.md's "Backups & point-in-time recovery" section for
the only real mitigation available today (a database-level backup),
since the application itself has no undo for this.

## Privacy & Third-Party Data Boundaries (Phase 15A)

This section documents the real, working privacy/data-protection mechanisms
in this codebase. **It is a technical description, not a legal claim.**
PAYNORA does not claim to be "GDPR compliant" or "fully GDPR compliant" as
a result of this phase's work — see `docs/privacy-policy.md`,
`docs/data-retention.md`, and `docs/data-flows.md` for the honest,
`NEEDS LEGAL REVIEW`-marked state of the actual legal foundation.

**Analytics has no field a secret, password, or full PII value could
occupy.** `trackEvent` (`src/server/analytics/events.ts`) and the PostHog
adapter (`src/server/analytics/providers/posthog.ts`) only ever forward the
fixed, narrow event shapes already enforced structurally elsewhere in this
codebase (see [Provider telemetry](#previously-established-phase-6) above
for the same pattern applied to `ProviderTelemetryEvent`) — there is no
code path that serializes a `User`, `Wallet`, or raw request body into an
analytics call. Every PostHog Capture API call sets `$geoip_disable: true`
as a defense-in-depth measure, even though the connecting IP is always
PAYNORA's own server, never an end customer's (the integration is 100%
server-side; no browser analytics script is ever loaded).

**Analytics is a real, per-organization opt-out, not cosmetic.**
`Organization.analyticsEnabled` (default `true`) is checked by
`isAnalyticsAllowedForOrganization` inside `trackEvent`'s existing
fire-and-forget chain — disabling it from Settings → Privacy
(`OWNER`-only, `src/app/app/[orgSlug]/settings/privacy-actions.ts`) means
no further event for that organization reaches the configured provider,
verified with tests in `src/server/analytics/events.test.ts`, not merely
asserted.

**The cookie-consent mechanism is honest about what it currently gates.**
`src/lib/privacy/cookie-consent.ts` and the banner
(`src/components/cookie-consent-banner.tsx`) record a real
Accept/Reject/undecided choice in a cookie, mirroring the existing
`src/lib/i18n/` locale-cookie pattern. Because PostHog has no browser SDK
in this codebase, there is currently no browser analytics cookie for this
choice to technically gate — this is documented, not hidden, in
`docs/privacy-data-inventory.md#technical-data`. The real, working
analytics on/off control is `Organization.analyticsEnabled` above; the
cookie-consent record exists as the UI/legal-foundation piece for when (if
ever) a client-side analytics script is introduced.

**Account deletion never orphans a foreign key or touches organization
financial data.** `anonymizeUserAccount`
(`src/server/auth/account-deletion.ts`) overwrites `User.email`/`name`/
`passwordHash` in place and never deletes the `User` row — every foreign
key referencing that user's id (`OrganizationMember`,
`ActionProposal.decidedByUserId`, `CollectionPolicy.autoSendEnabledByUserId`,
...) stays valid. `Customer`/`Invoice`/`Payment` belong to the
organization (`organizationId`), never to an individual member, so
deleting one member's account can never remove or corrupt another
member's view of the organization's financial history. See
`getAccountDeletionWarnings` for the one thing deletion does surface
(informational only, never blocking): leaving an organization with no
remaining `OWNER`.

**Data export is scoped to the requesting user's own account data only.**
`exportUserData` (`src/server/auth/data-export.ts`), served by the
session-authenticated `GET /api/account/export` route, returns the user's
own identity fields and organization memberships — never
`Customer`/`Invoice`/`Payment` records, which are organization-owned and
already visible to every member through the product's own tenant-scoped
pages. A single member exporting an entire organization's financial
history unilaterally would itself be a privacy/authorization problem, not
a privacy feature — this boundary is deliberate, covered by tests in
`src/server/auth/data-export.test.ts` (a user's export never includes
another user's memberships, and never includes `passwordHash`).

**Financial and audit data is never auto-deleted "for GDPR."**
`docs/data-retention.md` is explicit that `Invoice`/`Payment`/wallet
transaction/`ActivityEvent` records are retained, not purged, on account
or organization changes — inventing an automatic deletion policy for
records that may carry a real accounting/audit retention obligation would
be a compliance risk, not a compliance feature. See that document for the
full reasoning and its `NEEDS LEGAL REVIEW` markers on retention *periods*
specifically (as opposed to the retention *behavior*, which is a real,
already-implemented decision).

See `docs/privacy-data-inventory.md`, `docs/data-flows.md`, and
`docs/data-retention.md` for the full design and the honest gaps this
phase does not close.

## Previously established (Phase 6)

- **Secrets are never sent to the client, logged, or included in an
  error.** Every new secret env var (`OPENROUTER_API_KEY`,
  `MISTRAL_API_KEY`, `TELEGRAM_BOT_TOKEN`) lives under `src/server/` or
  `src/lib/env.ts` only. The shared OpenRouter/Mistral HTTP helper
  (`src/server/ai/providers/openai-compatible-chat.ts`) throws only the
  HTTP status code on a non-OK response — never the response body (could
  echo request content) or any request header (would include the
  `Authorization` bearer). The Telegram adapter never includes the request
  URL (embeds the bot token as a path segment) in a thrown error — only
  the status code and Telegram's own `description` field. Tested directly:
  `openrouter.test.ts`/`mistral.test.ts`/`telegram.test.ts` each assert a
  thrown error's message never contains the configured secret, even when
  the mocked vendor response body itself contains something secret-shaped.
- **Provider telemetry has no field a secret, password, email body,
  invoice content, or raw webhook payload could occupy** —
  `ProviderTelemetryEvent` (`src/server/providers/telemetry.ts`) is a
  fixed, narrow shape enforced structurally (TypeScript rejects an
  unlisted field), not just by convention. Wired into every gateway
  (`ai/gateway.ts`, `email/gateway.ts`, `messaging/gateway.ts`) so every
  call is recorded regardless of caller, with tests asserting the message
  text/recipient/request contents never appear in a logged line.
- **AI routing is bounded, never an unbounded retry loop.**
  `tryGenerateStructured` (`src/server/ai/service.ts`) tries at most two
  providers — `AI_PROVIDER` then, only if configured, a distinct
  `AI_PROVIDER_FALLBACK` — and stops at the first confirmed (schema-
  validated) success; a provider that's unimplemented, misconfigured,
  timed out, errored, or returned invalid output is tried at most once,
  never retried itself. Proven with tests that count exactly how many
  times a given provider was resolved/called under every failure
  combination — see `src/server/ai/service.test.ts`.
- **`BillingProvider` cannot change financial state and cannot fabricate
  a webhook's authenticity** — see
  [Trust boundary chain (Integration & Provider Foundation)](#trust-boundary-chain-integration--provider-foundation-phase-6)
  above.
- **No live network probe for health.** `resolveHealth`
  (`src/server/providers/registry.ts`) is a pure function of configuration
  — no code path in this phase can trigger a real email, AI call, or
  Telegram message as a side effect of checking health.
- **Zero AI/Messaging/Billing credentials required to run the app** —
  `AI_PROVIDER`/`MESSAGING_PROVIDER`/`BILLING_PROVIDER` all default to
  `"none"`; the full test suite (378 tests) and CI never set any of the
  new Phase 6 secrets and make zero real network calls to OpenRouter,
  Mistral, or Telegram.
- **As of Phase 6, neither Messaging nor Billing had a domain caller yet**
  — Messaging's first real caller (Telegram as a communication channel)
  was added in Phase 8; see
  [Trust boundary chain (Production Communications & AI)](#trust-boundary-chain-production-communications--ai-phase-8)
  above for the authorization boundary that applies now that it does.
  Billing still has no domain caller (a `BillingProvider` never itself
  changes financial state — see above).
- **Every new module still respects `tsconfig.json`'s `strict` mode and
  the existing Zod-at-the-boundary discipline** — `AI_PROVIDER_FALLBACK`,
  `MESSAGING_PROVIDER`/`TELEGRAM_BOT_TOKEN`,
  `BILLING_PROVIDER`/`DEPLOYMENT_PROFILE`, and the OpenRouter/Mistral
  config vars are all validated in `src/lib/env.ts`'s `superRefine` (e.g.
  Telegram requires `TELEGRAM_BOT_TOKEN`; OpenRouter/Mistral require their
  key+model whether selected as primary or fallback), tested in
  `src/lib/env.test.ts`.

See `docs/integration-architecture.md` for the full design.

## Previously established (Phase 5)

- **A schedule is never permission to send.** Every organization/sequence
  the tick considers is re-checked against live state — paid, cancelled,
  archived customer, disabled policy, or a blocked-by-uncertain-delivery
  invoice all result in zero action, every time, regardless of what an
  earlier tick decided. See
  [Trust boundary chain (Collections Automation)](#trust-boundary-chain-collections-automation-phase-5).
- **Two independent kill switches, both required.** The deployment-level
  `AUTOMATION_ENABLED` env flag (default `false`) and the organization-
  level toggle (default `false`) both gate the entire tick — an
  organization can never receive automated action unless both an operator
  and that organization's owner have explicitly opted in.
- **`AUTO_SEND` cannot bypass approval/send semantics** — see
  [Trust boundary chain (Collections Automation)](#trust-boundary-chain-collections-automation-phase-5).
  Default off; OWNER-only opt-in, recorded with the authorizing user and
  timestamp (`CollectionPolicy.autoSendEnabledByUserId`/`autoSendEnabledAt`).
- **No client-supplied execution time or tenant.** `runAutomationTick`'s
  `now` parameter is only ever populated with `new Date()` in production
  code paths; the scheduler endpoint (`POST /internal/automation/tick`)
  parses no request body at all, so there is no field a caller could use
  to select or spoof which organization gets processed.
- **Scheduler authentication.** `AUTOMATION_CRON_SECRET`, compared with
  `crypto.timingSafeEqual` to avoid a timing side channel; a missing or
  wrong secret returns `401` with no detail about what was expected, and
  an unconfigured deployment returns `503` before any comparison even
  happens.
- **DB-backed worker-vs-worker invariant**, not an in-memory lock:
  `@@unique([sequenceId, stepId])` on `CollectionStepExecution` — proven
  with a real concurrent-tick test asserting exactly one execution
  results, in both `APPROVAL_REQUIRED` and `AUTO_SEND` modes (the latter
  additionally proving the email provider is called exactly once).
- **Every Phase 5 resource is tenant-scoped** (`CollectionPolicy`,
  `CollectionPolicyStep`, `CollectionSequence`, `CollectionStepExecution`)
  the same way every earlier phase's resources are — covered by tenant
  isolation tests in `src/server/collections/*.test.ts`.
- **No secret logging.** `AUTOMATION_CRON_SECRET` is never written to any
  log; `runAutomationTick`'s structured summary log line contains only
  counts and organization ids, never an email body or AI credential.
- **Server-side allowlisting, again.** `CollectionStepAction` is checked
  against a server-side allowlist (`ALLOWED_COLLECTION_STEP_ACTIONS`,
  `src/server/collections/policy-schema.ts`) — the same pattern as Phase
  3's `ActionType` allowlist — and recipients are always resolved
  server-side from `Customer.email` via the reused Phase 4 draft
  function, never a client-suppliable value.

## Previously established (Phase 4)

- **Sending is always a distinct, explicit, later action** — see
  [Trust boundary chain (Communications / Email)](#trust-boundary-chain-communications--email-phase-4)
  above. Approving a proposal (Phase 3) is unchanged and still never
  sends anything.
- **Recipient and sender are never user input.** `Communication.recipient`
  is set once, server-side, from `Customer.email`, at draft-creation time
  — no form field anywhere accepts an arbitrary recipient.
  `PAYNORA_EMAIL_FROM` is a server environment variable; there is no
  per-message `from` field. This is what keeps Phase 4 from becoming a
  general-purpose email relay — see `docs/communications.md#sender-safety`.
- **Header injection is rejected, not sanitized.** A subject containing a
  CR or LF is rejected outright by `updateCommunicationDraft`'s Zod
  schema (`src/server/communications/editing.ts`), not stripped or
  escaped — tested directly against a `Bcc:`-injection attempt.
- **No duplicate provider dispatch under concurrency.** `sendCommunication`
  claims a communication via an atomic conditional DB update before ever
  calling the provider; a double-click, two concurrent requests, or a
  concurrent retry can only ever result in one actual provider call —
  proven with real concurrent-request tests that count actual invocations
  of the (fake) provider, not just check the final DB state. See
  `docs/communications.md#concurrency`.
- **Ambiguous outcomes are never presented as certain.** A timeout or
  unrecognized provider error is recorded as `UNCERTAIN`, distinct from a
  confirmed `FAILED` — the UI says "Delivery status uncertain. Do not
  resend automatically," and resending requires an explicit, separately-
  labeled, confirmation-gated action, never a blind automatic retry. See
  `docs/communications.md#unknown-outcomes`.
- **No email credentials required to run the app**: `EMAIL_PROVIDER`
  defaults to `"none"`; the app boots, and drafting/preview/editing all
  work end to end with zero email configuration. Verified by CI, which
  never sets `EMAIL_PROVIDER` and makes zero real email network calls.
- **Every Phase 4 resource is tenant-scoped** (`Communication`,
  `DeliveryAttempt`) the same way Phase 2/3 resources are — covered by
  tenant isolation tests in `src/server/communications/*.test.ts`.
- **`ActionProposal.EXECUTED` is set in exactly one place**
  (`src/server/communications/send.ts`, on confirmed success only), via
  the same atomic conditional-update pattern as Phase 3's approval fix —
  a failed or uncertain send can never be mistaken for an executed one.

## Previously established (Phase 3)

- **AI is never authorization and never a source of financial truth** —
  see [Trust boundary chain](#trust-boundary-chain-operator--ai-phase-3) above.
- **Action type allowlisting**: `src/server/operator/proposals.ts` checks
  every proposed action against a server-side allowlist
  (`SEND_PAYMENT_REMINDER` only in Phase 3) before writing a row. AI is
  never asked for and never validated to produce an action type — the
  schema it must satisfy (`reminderInsightOutputSchema`) has no such field.
- **AI output validation**: every `AIProvider` response is validated
  against a Zod schema (`runAIGeneration`, `src/server/ai/gateway.ts`)
  before any caller sees it; invalid output is discarded, never partially
  trusted.
- **No AI credentials required to run the app**: `AI_PROVIDER` defaults to
  `"none"`; the app boots, and the Operator pipeline runs end to end
  (event detection, insight/proposal creation with deterministic
  fallback), with zero AI configuration. Verified by CI, which never sets
  `AI_PROVIDER` and makes zero AI network calls.
- **Approval is a strict, tenant-scoped state machine**:
  `src/server/operator/approval.ts` only allows `PENDING` → `APPROVED` or
  `PENDING` → `DISMISSED` (same-state calls are idempotent no-ops;
  anything else throws `InvalidActionProposalTransitionError`), scoped by
  `organizationId` (`OperatorResourceNotFoundError` for a cross-tenant
  proposal id — the same enumeration-safe pattern as Phase 1/2), and
  audited via the existing `ActivityEvent` trail.
- **Approving never executes anything.** There is no send path in Phase 3
  — the Action Center UI is explicit about this ("Approved — execution is
  not enabled yet"), never implying an action was actually taken.
- **Every Phase 3 resource is tenant-scoped** (`BusinessEvent`,
  `OperatorInsight`, `ActionProposal`) the same way Phase 2 resources are —
  covered by tenant isolation tests in every `src/server/operator/*.test.ts` file.
- **Idempotency**: every write in the Operator pipeline is enforced
  idempotent by a database unique constraint, not just an application-level
  check — re-running the pipeline, including under concurrent requests,
  converges on the same rows rather than duplicating them. See
  `docs/operator-foundation.md#idempotency`.

## Previously established (Phase 2)

- **Financial amounts are never trusted from the client.** Every
  Server Action re-derives outstanding balances and validates amounts
  server-side (`amountMinorSchema`, `parseAmountInput` — see
  `docs/accounts-receivable.md`); nothing about a payment's validity is
  decided from a value the browser calculated or sent unchecked.
- **Overpayment and race conditions**: `recordPayment` locks the invoice
  row (`SELECT ... FOR UPDATE`) for the transaction's duration, so two
  concurrent payment submissions against the same invoice cannot jointly
  overpay it. Verified with a real concurrent-request test
  (`src/server/ar/payments.test.ts`), not just documented — see
  `docs/accounts-receivable.md#concurrency`.
- **Every Phase 2 resource is tenant-scoped** (`Customer`, `Invoice`,
  `Payment`, `ActivityEvent`): all lookups filter by `organizationId`
  alongside the resource id, so a cross-tenant id fails exactly like a
  nonexistent one (`ArResourceNotFoundError`) — the same enumeration-safe
  pattern as Phase 1's organization access checks. Covered by tenant
  isolation tests in every `src/server/ar/*.test.ts` file.
- **Mass assignment**: Server Actions read named `FormData` fields
  individually and pass them through a Zod schema — never a raw spread of
  client-submitted data into a Prisma `data:` object.
- **Archived customers**: archiving excludes a customer from the invoice
  creation picker but never touches their existing invoices or payments —
  archival cannot be used to make it look like money owed disappeared.
- **Financial history is not deletable** through normal application code
  paths: `Invoice.customerId` and `Payment.invoiceId` foreign keys are
  `ON DELETE RESTRICT`, and there is no invoice or payment delete
  operation at all — see `docs/accounts-receivable.md#archival--deletion`.
- **Input validation**: customer, invoice, and payment input all go
  through Zod schemas (`src/server/ar/customers.ts`, `invoices.ts`,
  `payments.ts`) before touching the database, including cross-field
  checks (due date on/after issue date) and currency allowlisting.

## Previously established (Phase 1)

- **Passwords** are hashed with bcrypt (cost 12, `src/server/auth/password.ts`)
  and never stored or logged in plain text. Login compares against a
  precomputed dummy hash when no user is found, so a failed login takes
  the same time whether or not the email exists — timing-based account
  enumeration doesn't work.
- **Sessions** are Auth.js-managed JWTs, signed/encrypted with
  `AUTH_SECRET` (required, ≥32 characters, no default — `src/lib/env.ts`
  fails startup rather than falling back to something predictable). The
  session carries only `{ id, email, name }` — no role or organization
  claims, so a stale token can't grant stale authorization.
- **CSRF**: Auth.js's own sign-in/sign-out flow has built-in CSRF
  protection when invoked through its `signIn`/`signOut` functions (used
  here, not a hand-rolled fetch). PAYNORA's own Server Actions
  (`createOrganization`, `registerUser`, org rename) get Next.js's
  built-in Server Action CSRF protection (Origin/Host header validation)
  for free — neither is reimplemented.
- **Tenant isolation** is enforced in `src/server/tenancy/context.ts` on
  every organization-scoped request: membership is re-verified against the
  database by URL slug on every call, never trusted from a cookie or
  client-supplied value. Automated tests
  (`src/server/tenancy/context.test.ts`) run against a real database and
  cover cross-tenant access, unauthenticated access, and role checks — see
  `docs/identity-and-tenancy.md`.
- **Organization enumeration**: "no such organization", "organization
  exists but you're not a member", and "wrong role for this operation" all
  produce the identical outcome (`OrganizationAccessDeniedError`, a 404 on
  pages) — an attacker can't use response differences to discover which
  org slugs exist.
- **Unsafe redirects**: the sign-in flow's `callbackUrl` is validated to be
  a relative in-app path before use (both in the page and the Server
  Action) — an absolute URL is ignored in favor of `/app`, preventing an
  open-redirect via a crafted sign-in link.
- **Input validation**: registration and organization name/rename go
  through Zod schemas (`src/server/auth/users.ts`,
  `src/server/tenancy/organizations.ts`) before touching the database.
- No secrets are committed. `.env.example` documents variable names and,
  for `AUTH_SECRET`, deliberately ships no value.
- Dependencies are installed from the public npm registry with no known
  vulnerabilities at time of writing (`npm audit` reports 0 vulnerabilities
  as of the last dependency install).
- CI runs typecheck, lint, and the full test suite (including tenant
  isolation) against a real Postgres service container on every change.

## Reporting a vulnerability

This repository does not yet have a public release or paying customers.
Until a dedicated security contact is published here, report concerns by
opening a GitHub issue marked `security` with minimal public detail, or by
contacting the repository owner directly.
