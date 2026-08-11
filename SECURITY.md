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

## Current status (Phase 5)

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
