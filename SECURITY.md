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
insight's summary wording) — validated against a fixed schema before use,
and always with a deterministic fallback when AI is disabled, misconfigured,
times out, or fails. See `docs/operator-foundation.md` and
`docs/ai-architecture.md` for the full design.

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
- **Idempotency for money-adjacent automation.** Background jobs and
  webhook handlers (Phase 4+) are designed to be safely retried — running a
  reminder job twice must not send a duplicate reminder.
- **No sensitive data in logs.** Structured logging (introduced when
  observability infrastructure is added) excludes credentials, tokens, and
  full customer payment details.

## Current status (Phase 3)

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
