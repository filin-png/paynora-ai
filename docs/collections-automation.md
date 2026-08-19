# Collections Automation (Phase 5)

**Status: implemented, disabled by default everywhere.** This document
describes what Phase 5 actually built: a scheduling capability layered on
top of the existing AR → Operator → Communications → Email pipeline, so
overdue invoices can be re-checked and — with explicit configuration —
acted on without a human clicking "Run Operator" every day. Phase 5 adds
**no new way to send anything**; every action the automation engine takes
flows through the exact same primitives Phase 3/4 already built and
tested.

## The core rule: schedule ≠ permission to send

A scheduled tick means exactly one thing: *"it's time to re-check whether
this invoice needs the next collections action."* It never means "send
unconditionally." Every single time `runAutomationTick` considers acting
on an invoice, it re-derives the answer from scratch — organization kill
switch, sequence status, live financial state, policy enabled/disabled,
customer archived, prior communication state — never from what a previous
tick decided. An invoice that was overdue an hour ago and is paid now gets
zero communication, unconditionally, every time.

This principle is why the engine is structured the way it is below: every
stage that could plausibly decide "send," re-verifies its precondition
immediately before doing so, using the same authoritative Phase 2 AR
functions everything else in this codebase uses — never a cached or
snapshotted amount.

## Why a new event type instead of reusing INVOICE_OVERDUE

Phase 3's `BusinessEvent` for `INVOICE_OVERDUE` is a structural singleton:
`@@unique([organizationId, type, dedupeKey])` with `dedupeKey = invoiceId`
means at most **one** overdue event, insight, and proposal can ever exist
per invoice, for its whole lifetime. That's correct for Phase 3's one-shot
manual detection, but Phase 5 needs *multiple* distinct reminders over an
invoice's lifetime — one per policy step.

Rather than changing `INVOICE_OVERDUE`'s semantics (which would be a
breaking change to already-tested Phase 3 behavior) or inventing a second
Operator, Phase 5 adds `BusinessEventType.COLLECTION_STEP_DUE`, deduped by
`dedupeKey = CollectionStepExecution.id` — a value that's already unique
per (sequence, step) via its own database constraint (see
[Concurrency](#concurrency)). Each policy step therefore gets its own
independent, idempotent `BusinessEvent → OperatorInsight → ActionProposal`
chain, created by the **same functions** Phase 3 already has:
`ensureInsightForInvoiceOverdueEvent`
(`src/server/operator/insights.ts` — the name predates Phase 5 and is
misleading now; it only ever depended on `event.invoiceId`, not
`event.type`, so it works unchanged) and `ensureReminderProposalForInsight`
(`src/server/operator/proposals.ts`, extended with an optional
`{ tone }` parameter so a policy step's configured tone drives the
reminder instead of the insight's priority — the only change made to
existing Phase 3 code). `INVOICE_OVERDUE` itself is untouched.

`Communication.actionProposalId` is still `@unique` (one Communication per
proposal, Phase 4) — this is compatible by construction, because each
policy step produces its own distinct `ActionProposal`, so each also gets
its own distinct `Communication`. No Phase 4 constraint needed to change.

## Automation architecture

```
CollectionPolicy (tenant template)
  └─ CollectionPolicyStep[] (versioned: daysAfterDue, action, tone)
       ↓ (enrollment)
CollectionSequence (one per invoice, locks in policyId + policyVersion)
  └─ CollectionStepExecution[] (claimed/executed/skipped, one per step)
       ↓ (runAutomationTick, per due step)
BusinessEvent(COLLECTION_STEP_DUE) → OperatorInsight → ActionProposal   [Phase 3, reused]
       ↓ (human, or — only if explicitly enabled — AUTO_SEND)
Communication → sendCommunication() → EmailProvider                     [Phase 4, reused]
```

Code map:

| Concern | Code |
| --- | --- |
| Policy CRUD, versioning, kill switches | `src/server/collections/policy.ts` |
| Enrollment | `src/server/collections/enrollment.ts` |
| The engine (`runAutomationTick`) | `src/server/collections/engine.ts` |
| Sequence pause/resume/stop, UI status projection | `src/server/collections/sequences.ts` |
| Scheduler HTTP auth | `src/server/collections/scheduler-auth.ts` |
| Scheduler adapter endpoint | `src/app/internal/automation/tick/route.ts` |
| UI | `src/app/app/[orgSlug]/automation/*`, invoice detail page's collections block |

## Policy model

`CollectionPolicy` (tenant-scoped):

- `name`, `enabled` (default `false`), `automationMode`
  (`APPROVAL_REQUIRED` default, or `AUTO_SEND`), `isDefault`,
  `currentVersion`.
- `autoSendEnabledByUserId` / `autoSendEnabledAt` — set only when an OWNER
  explicitly switches `automationMode` to `AUTO_SEND`
  (`setCollectionPolicyAutomationMode`); cleared on switching back. This
  is the acting user for every automatic approve/send the engine performs
  under that policy — see [Auto-send](#auto-send).

`CollectionPolicyStep`: `daysAfterDue`, `action` (allowlisted —
`SEND_PAYMENT_REMINDER`, `NOTIFY_OWNER`, see
`ALLOWED_COLLECTION_STEP_ACTIONS` in `policy-schema.ts`), `tone` (`SOFT` /
`STANDARD` / `FIRM`), and a `stepOrder` that is **never client-supplied**
— it's derived by sorting the validated step list by `daysAfterDue`
ascending (`deriveOrderedSteps`). This removes "invalid step ordering" as
a distinct input category entirely: a step's position *is* its day
threshold. What's still rejected is two steps claiming the same day
threshold (`collectionPolicyStepsInputSchema`'s `.refine`), and an empty
step list. No raw cron expressions are ever accepted from a client —
`daysAfterDue` is a plain non-negative integer.

**Versioning.** Editing a policy's steps (`updateCollectionPolicySteps`)
never mutates existing `CollectionPolicyStep` rows — it writes a new,
higher `version` and bumps `CollectionPolicy.currentVersion`. Old versions
are never deleted (`CollectionStepExecution.stepId` is `onDelete:
Restrict`). A `CollectionSequence` locks in the policy's *current* version
at enrollment time (`policyVersion`) and reads only that version's steps
for its whole lifetime — editing the policy afterward can never
retroactively change an in-flight sequence's behavior.

**Default policy template.** `DEFAULT_POLICY_TEMPLATE`
(`policy-schema.ts`): day+1 SOFT, day+3 STANDARD, day+7 FIRM, day+14
NOTIFY_OWNER FIRM. An OWNER can create a policy from this template with
one click (`createDefaultPolicyAction`), but the created policy is
`enabled: false` like any other — the template is a starting point for
configuration, never something that sends on its own.

**Permissions.** Every policy-configuration function
(`createCollectionPolicy`, `updateCollectionPolicySteps`,
`setCollectionPolicyEnabled`, `setDefaultCollectionPolicy`,
`setCollectionPolicyAutomationMode`, `setOrganizationAutomationEnabled`)
is called only from Server Actions gated by
`requireOrganizationRoleForPage(orgSlug, "OWNER")` — the same
authorization layering as every other OWNER-only action in this app
(`src/app/app/[orgSlug]/settings/actions.ts`). MEMBERs can view the
Automation page and pause/resume nothing — every mutating control on that
page is conditionally rendered only for `role === "OWNER"`.

## Sequence lifecycle

`CollectionSequence` — the runtime instance of a policy applied to one
invoice:

```
ACTIVE --(payment in full)--> COMPLETED (stopReason PAID)
ACTIVE --(cancelled / customer archived / policy disabled)--> STOPPED
ACTIVE --(OWNER pause)--> PAUSED --(OWNER resume)--> ACTIVE
ACTIVE --(OWNER manual stop)--> STOPPED (stopReason MANUAL)
```

`@@unique([organizationId, invoiceId])` — at most one sequence per
invoice, ever. `COMPLETED` and `STOPPED` are both terminal; there is no
"un-stop." A `POLICY_DISABLED` stop does **not** auto-resume when the
policy is re-enabled later — that's a deliberate minimal design (see
[Limitations](#limitations)): resuming a policy-disabled sequence
automatically would risk exactly the "resume with a burst of stale
reminders" problem catch-up semantics exist to prevent for the *time-gap*
case; requiring a fresh, explicit decision for the *configuration-change*
case is the simpler and safer default.

Pausing/resuming/stopping (`src/server/collections/sequences.ts`) are each
atomic conditional updates (`WHERE status = <expected>`), the same
technique as Phase 3's proposal approval — see
[Concurrency](#concurrency) for why this matters when a worker is
mid-tick.

## Scheduling

```ts
runAutomationTick(now: Date = new Date(), options?: {
  organizationId?: string;   // omit for a global tick across every automationEnabled org
  globalEnabled?: boolean;   // test-only override of the AUTOMATION_ENABLED env flag
  emailProvider?: EmailProvider; // test-only DI, same pattern as sendCommunication
}): Promise<AutomationTickSummary>
```

- **Deterministic w.r.t. `now`.** Every date computation downstream —
  `getInvoiceWithFinancials`, `listInvoicesWithFinancials`,
  `buildDeterministicInvoiceContext` — accepts an optional `today: string`
  override (Phase 5 addition, backward compatible; every pre-existing
  caller omits it and keeps using the real server clock via
  `getBusinessToday()`). `runAutomationTick` derives `today` once from its
  `now` parameter and threads it through everywhere, so two calls with the
  same `now` are byte-for-byte equivalent in their date reasoning — proven
  by the idempotency tests, not just asserted.
- **Never trusts client time.** Production callers (the manual dev
  trigger, the scheduler endpoint) always pass `new Date()` — the server's
  own clock. There is no code path that accepts a client-supplied `now`;
  the parameter exists purely for deterministic tests.
- **UTC, date-only.** Same semantics as Phase 2 invoice due dates — see
  `docs/accounts-receivable.md#date-semantics`. `daysBetween` compares
  "YYYY-MM-DD" strings, immune to DST.
- **Tenant-safe.** `options.organizationId` scopes a tick to one
  organization (used by the dev-only manual trigger, always after an
  OWNER-role check); omitting it processes every organization with
  `automationEnabled = true`. A per-organization automationEnabled check
  happens both when selecting target organizations *and* is the reason
  the org even appears in that query — there is no path where a
  disabled-automation org's data is touched.

### Per-organization query strategy

`processOrganizationTick` bulk-fetches, once per organization per tick:
financials for every invoice (`listInvoicesWithFinancials(org, "all")` —
2 queries total regardless of invoice count), the org's active sequences,
the distinct policies and policy-step-versions those sequences reference,
existing step executions for those sequences, and any blocking
(`SENDING`/`UNCERTAIN`) communications for those invoices — roughly 7
bulk queries per organization per tick, independent of how many invoices
or sequences it has. See [Performance](#performance) for the one
remaining per-invoice cost and its documented scaling boundary.

## Catch-up semantics

If the scheduler doesn't run for days, an invoice can accumulate several
"due" steps by the time it runs again (e.g. day+1 and day+3 both passed).
Sending both at once would be a reminder burst — explicitly forbidden.

`findDueSteps` (`engine.ts`, a pure function with no I/O, directly unit
tested) is the whole policy: of every not-yet-executed step whose
threshold has passed, only the **single most-advanced** one (highest
`daysAfterDue`) is actually executed; every earlier one is marked
`SKIPPED` with a note ("Superseded by a later due step in the same
catch-up pass"). Each skip is itself claimed via the same
create-then-catch-P2002 pattern as a real execution, so skipping is just
as idempotent and race-safe as executing — a `CollectionStepExecution`
row exists for every step a tick considered, whether it ran or was
superseded.

A gap spanning multiple ticks behaves the same way each tick: if a
scheduler outage means day+1 already ran but day+3 and day+7 are now both
overdue by the time it recovers, the next tick executes only day+7 and
marks day+3 `SKIPPED` — never bursts two emails. See
`src/server/collections/engine.test.ts`'s catch-up describe block for the
exact scenarios (fresh sequence jumping straight to a deep-overdue day;
one step already executed, then a gap).

## Payment / cancellation safety

**Full payment stops the sequence.** Not synchronously from
`recordPayment` (Phase 2) — that would couple AR to automation, which
this codebase deliberately avoids (see
[Existing-integration philosophy](#reusing-existing-primitives) below).
Instead, self-healing: the next tick's eligibility re-check
(`financials.isPaid`) sees the paid invoice and stops the sequence
(`COMPLETED`, `stopReason: PAID`) before considering any step. Until that
next tick runs, the sequence row still says `ACTIVE` — but the invoice
detail page never shows it as needing further collection either way,
because `getCollectionStatusForInvoice` also derives its display live
from current financials-adjacent state, not from the sequence's own
possibly-stale status field. (In this codebase's actual behavior, the
sequence and the invoice-paid fact converge on the very next tick; the
UI's honesty doesn't depend on that convergence having already happened.)

**Partial payment does not stop the sequence.** Outstanding is
recomputed live on every tick from `computeInvoiceFinancials` — never a
stored amount — so later steps' `BusinessEvent.data.outstandingAmount`
snapshot (kept for audit/display only, never re-read as truth) always
reflects the current balance, not the balance at enrollment time.

**Cancellation stops the sequence** the same self-healing way, via
`invoice.status === "CANCELLED"`, reusing Phase 2's own status field —
Phase 5 never introduces a second source of "is this invoice still
open."

**The payment↔automation race**, closed in two layers:

1. The main eligibility re-check (paid/cancelled/archived/policy-disabled)
   happens once per sequence per tick, using data bulk-fetched at the
   start of that organization's tick.
2. **Immediately after successfully claiming a step** (i.e. right before
   creating any `BusinessEvent`/proposal), the engine does one more
   *fresh, targeted* `getInvoiceWithFinancials` call — not from the bulk
   snapshot — specifically to catch a payment that landed during this
   tick's processing of *other* invoices. If now paid/cancelled, the
   claimed step is marked `SKIPPED` and the sequence is stopped correctly,
   with nothing created.
3. On the `AUTO_SEND` path specifically, there's a **third** re-check,
   immediately before the `sendCommunication()` call — the one place an
   external side effect is about to happen. See
   [Auto-send](#auto-send).

The irreducible gap that remains, documented rather than hidden: between
that final re-check and the actual provider call (or, on
`APPROVAL_REQUIRED`, between the re-check and a human clicking Send
possibly minutes/hours later), a payment can still land. This is the same
accepted gap Phase 4 already documents for manual sends
(`docs/communications.md#why-a-db-transaction-cant-wrap-the-provider-call`)
— Phase 5 does not attempt to close it further, consistent with "no
outbox/reconciliation process without proven necessity."

## Concurrency

The DB-backed invariant that makes one logical collection step of one
invoice impossible to execute twice, even under concurrent workers:
`CollectionStepExecution` has `@@unique([sequenceId, stepId])`. Claiming a
step is a plain `INSERT`; a second worker's identical insert fails with
Postgres's `P2002` unique-violation, caught and treated as "already
claimed, nothing to do" — the same create-then-catch pattern used
throughout Phases 3/4 for idempotent creation (`BusinessEvent`,
`OperatorInsight`, `ActionProposal`, `Communication`), not a new
concurrency primitive.

Real concurrent-worker tests (`engine.test.ts`) fire two `runAutomationTick`
calls with `Promise.all` against the same due step and assert exactly one
execution resulted — both in `APPROVAL_REQUIRED` mode (one `ActionProposal`
created) and in `AUTO_SEND` mode (the email provider's `send` called
exactly once, proven with a call-counting wrapper provider).

**Pause↔worker race.** A sequence can be paused by an OWNER between the
bulk read at the start of an organization's tick and a specific step's
claim later in that same tick. After claiming, the engine re-reads the
authoritative `CollectionSequence` row (not the in-memory copy from the
bulk read); if it's no longer `ACTIVE`, the just-claimed step is marked
`SKIPPED` ("Sequence is no longer ACTIVE") and nothing further happens for
it. The claim itself still exists — this step will never be reconsidered
even after a later resume, which is intentional: resuming does not
retroactively execute what a pause interrupted.

**Pause/kill-switch/mode-switch ↔ AUTO_SEND race (closed in the adversarial
pre-merge audit).** The check above runs once, right after claiming —
before the proposal is even created. It does not by itself protect the
*later* `AUTO_SEND` dispatch: between that check and the actual
`sendCommunication()` call, drafting (`prepareReminderCommunication`,
which can involve an AI round trip) and an `approveActionProposal` call
both happen, widening the window in which an OWNER could pause the
sequence, flip the organization kill switch, or switch the policy back to
`APPROVAL_REQUIRED`. `executeAutoSend` therefore re-verifies all three —
sequence still `ACTIVE`, organization `automationEnabled` still true,
policy still `enabled` and still `AUTO_SEND` — via `isAutoSendStillAuthorized`,
from fresh reads, immediately before the send, exactly mirroring the
existing pre-send financial re-check. If any condition no longer holds,
`executeAutoSend` returns without sending, leaving the drafted
`Communication` in `DRAFT` for a human to review through the ordinary
Action Center flow. See `src/server/collections/engine.test.ts`'s
`isAutoSendStillAuthorized` describe block for the regression coverage.

**Crash recovery / stuck CLAIMED.** If the process dies between claiming a
step (`CLAIMED`) and marking it `EXECUTED`/`SKIPPED`, that
`CollectionStepExecution` row stays `CLAIMED` forever — the unique
constraint means this exact step can never be reclaimed, so that
sequence's progression on that specific step is permanently blocked
without human intervention. This is the same accepted, human-resolvable
tradeoff as a stuck `Communication.SENDING` row (Phase 4) — not
auto-retried, not silently worked around, surfaced as a stall a human
(or a future admin tool) has to notice and fix. No reconciler was built
for this, per the explicit instruction not to build scheduler/reconciler
infrastructure without proven necessity. In practice the window is small:
the claim insert and the `EXECUTED`/`SKIPPED` update that follows are
each individually fast, non-transaction-spanning operations.

## Auto-send

**Implemented**, because a correct implementation was possible without
any bypass of Phase 3/4 safety — see the reasoning below. Default `OFF`
(`CollectionPolicy.automationMode` defaults to `APPROVAL_REQUIRED`);
switching a policy to `AUTO_SEND` requires an OWNER
(`setCollectionPolicyAutomationMode`, gated by
`requireOrganizationRoleForPage(orgSlug, "OWNER")` at the Server Action
layer) and records that OWNER as `autoSendEnabledByUserId` —
a real, auditable acting user, never a null/system sentinel.

**Why this didn't require a dangerous bypass:** the entire auto-send path
is a straight-line composition of functions that already existed and were
already safe — `approveActionProposal` (Phase 3) and
`prepareReminderCommunication` + `sendCommunication` (Phase 4) — called
with `autoSendEnabledByUserId` as the acting `userId`, exactly as if that
OWNER had clicked Approve and Send themselves. Nothing about Phase 3/4's
approval semantics or Phase 4's send state machine needed to change or be
worked around:

```ts
// engine.ts, executeAutoSend — the entire auto-send implementation
await approveActionProposal(organizationId, proposalId, actingUserId);
const { communication } = await prepareReminderCommunication(organizationId, proposalId);
// one more fresh financial re-check here — see Payment/cancellation safety
await sendCommunication(organizationId, communication.id, actingUserId, { provider: emailProvider });
```

There is no code path anywhere in `src/server/collections/` that
constructs an `EmailMessage`, imports `nodemailer`, or calls an
`EmailProvider` directly — `sendCommunication` is the only caller of an
`EmailProvider`, exactly as in Phase 4.

**Safety properties, each with a test:**

- Default `OFF` — `APPROVAL_REQUIRED` is the schema default; a policy
  created from the template stays `APPROVAL_REQUIRED` until an OWNER
  explicitly switches it.
- OWNER-only opt-in — enforced at the Server Action layer, same as every
  other automation-configuration action.
- No arbitrary recipient/content — `sendCommunication` is called with the
  exact `communicationId` `prepareReminderCommunication` produced from the
  deterministic/AI-generated draft; there is no field anywhere in the
  auto-send path a caller could use to redirect the recipient or inject
  arbitrary content, same structural guarantee as the manual send path
  (`docs/communications.md#sender-safety`).
- Concurrent workers never double-send — proven the same way as the
  `APPROVAL_REQUIRED` concurrency test, with call-counting.
- Kill switch prevents new auto-sends — both the organization-level
  `automationEnabled` and the deployment-level `AUTOMATION_ENABLED` env
  flag gate the entire tick, auto-send included, before any step is even
  selected.
- Failure is not retried automatically — a rejected/uncertain send from
  the auto-send path leaves the `Communication` in `FAILED`/`UNCERTAIN`
  exactly like a manual send would, resolved through the existing manual
  retry UI, not a second retry mechanism.

## Communication integration

Phase 5 never constructs a `Communication` row itself, never sends an
email itself, and never introduces a second delivery-state machine. Every
Phase 4 guarantee — `DRAFT → SENDING → SENT|FAILED|UNCERTAIN`, Send↔Send
protection, Send↔Edit protection, provider timeout handling, the
uncertain-outcome UI — applies identically whether the `Communication`
came from a human clicking through the Action Center or from the
automation engine's `executeAutoSend`. There is no Phase-5-specific
Communication code path to audit separately.

**UNCERTAIN / stuck SENDING blocks further automation.** Before selecting
a step to execute for a sequence, the engine checks whether the invoice
has *any* `Communication` (automated or manual) with status `SENDING` or
`UNCERTAIN`. If so, the sequence is left exactly as-is — not stopped, not
paused, no step claimed, no `CollectionStepExecution` row created (since
no step was actually attempted) — and the tick's summary counts it as
`blocked`. This is a *self-healing* block: once a human resolves the
uncertain communication (confirms it wasn't delivered and retries, or
confirms it was and leaves it), the very next tick re-evaluates normally.
There is no "wait N days and send the next reminder anyway" logic
anywhere — an ambiguous outcome halts progression until a human input
changes it, full stop.

**Confirmed FAILED** does not block automation the way UNCERTAIN does —
a definite rejection means nothing was delivered, so it's safe reasoning
territory, same as Phase 4's own retry policy. Phase 5 does not add
automatic retry infrastructure for it; the existing manual Retry button
covers it.

## Enrollment

`enrollEligibleInvoices` (`enrollment.ts`) is called once per organization
at the start of every tick — not a per-invoice cron row, not a hook on
invoice creation. It bulk-fetches every `OPEN`, not-fully-paid invoice for
the organization plus the set of already-enrolled invoice ids (two bulk
queries), and calls the idempotent `enrollInvoice` (create-then-catch-
P2002 on `@@unique([organizationId, invoiceId])`) for each one lacking a
sequence, skipping archived customers. This design scales to a future
bulk invoice import without any special-casing: newly imported invoices
simply get picked up lazily on the next tick, the same as any other
never-before-seen invoice.

Enrollment only happens under the organization's designated **default
enabled policy** (`isDefault: true, enabled: true`) — Phase 5
deliberately does not support per-invoice or per-customer policy
assignment; every automatically-enrolled invoice in an organization uses
the same policy. This keeps the enrollment decision entirely mechanical
(one query, one answer) rather than a rules-matching problem, consistent
with "not a complex workflow builder." See
[Limitations](#limitations).

## Reusing existing primitives

Phase 5 was built under a hard constraint: **no second Operator, no
second email sender, no parallel financial-truth source.** Concretely:

- Financial state: always `getInvoiceWithFinancials`/
  `listInvoicesWithFinancials` (Phase 2) — Phase 5 only ever *adds* an
  optional `today` override to these, it never duplicates their logic.
- Insight/priority: `ensureInsightForInvoiceOverdueEvent`,
  `computeOverduePriority` (Phase 3) — reused verbatim for
  `COLLECTION_STEP_DUE` events.
- Proposal creation: `ensureReminderProposalForInsight` (Phase 3) —
  extended with an optional explicit `tone`, not forked.
- Approval: `approveActionProposal` (Phase 3) — reused verbatim in the
  auto-send path.
- Drafting and sending: `prepareReminderCommunication`,
  `sendCommunication` (Phase 4) — reused verbatim in the auto-send path.
- Audit trail: the existing `ActivityEvent` table, extended with new
  `ActivityEventType` values — no parallel audit log.

## Security

- **Tenant isolation.** Every collections domain function takes an
  already-authorized `organizationId` and filters every query by it,
  exactly like every other domain in this codebase — no new tenant model.
- **OWNER-only configuration.** Policy CRUD, mode switching, the
  organization kill switch, and sequence pause/resume/stop are all gated
  by `requireOrganizationRoleForPage(orgSlug, "OWNER")`.
- **Internal scheduler auth.** `POST /internal/automation/tick` requires
  a `Bearer` token matching `AUTOMATION_CRON_SECRET`, compared with
  `crypto.timingSafeEqual` (`scheduler-auth.ts`) to avoid a timing side
  channel. Missing/wrong secret → `401`. Deployment without
  `AUTOMATION_ENABLED`/`AUTOMATION_CRON_SECRET` configured → `503`,
  before any auth check runs (nothing to authenticate against).
- **No client-supplied execution time.** `runAutomationTick`'s `now`
  parameter is never populated from a request; the endpoint always calls
  `new Date()`.
- **No client-supplied tenant on the global tick.** The scheduler endpoint
  never parses a request body at all — there is no field a caller could
  set to scope or spoof which organization gets processed.
- **No bypass of Communication or ActionProposal permission semantics.**
  See [Auto-send](#auto-send) and
  [Communication integration](#communication-integration) — every write
  goes through the existing, already-audited functions.
- **No arbitrary actions or recipients.** `CollectionStepAction` is
  server-side allowlisted (`ALLOWED_COLLECTION_STEP_ACTIONS`), the same
  pattern as Phase 3's `ALLOWED_ACTION_TYPES`; recipients are always
  `Customer.email`, resolved server-side by the reused Phase 4 draft
  function.
- **No secret logging.** `AUTOMATION_CRON_SECRET` is never logged — the
  scheduler endpoint logs nothing on success beyond what
  `runAutomationTick`'s own structured summary logs (see
  [Observability](#observability)), and a rejected request logs nothing
  about the (wrong) secret it was sent.

## Database

New additive migration
(`prisma/migrations/20260811173159_phase5_collections_automation`) —
Phase 1–4 migrations are untouched. New models: `CollectionPolicy`,
`CollectionPolicyStep`, `CollectionSequence`, `CollectionStepExecution`.
New enums: `CollectionAutomationMode`, `CollectionStepAction`,
`ReminderTone`, `CollectionSequenceStatus`, `CollectionStopReason`,
`CollectionStepExecutionStatus`. New field: `Organization.automationEnabled`.
Extended enums (additive values only): `BusinessEventType`
(`COLLECTION_STEP_DUE`), `ActivityEventType` (ten new values).

Database-level invariants, not just application checks — hand-added
`CHECK` constraints follow the same `--create-only`-then-edit convention
Phase 2 established:

- `@@unique([organizationId, invoiceId])` on `CollectionSequence` — one
  sequence per invoice per organization, structurally.
- `@@unique([sequenceId, stepId])` on `CollectionStepExecution` — the
  worker-concurrency invariant (see [Concurrency](#concurrency)).
- `@@unique([policyId, version, stepOrder])` and
  `@@unique([policyId, version, daysAfterDue])` on `CollectionPolicyStep`
  — a policy version can never have two steps at the same position or day
  threshold.
- `CHECK ("daysAfterDue" >= 0)`, `CHECK ("stepOrder" > 0)`,
  `CHECK ("currentVersion" > 0)`, `CHECK ("policyVersion" > 0)`.

## Tests

`src/server/collections/*.test.ts` (64 tests), plus
`src/app/internal/automation/tick/route.test.ts` (4 tests) and four new
`AUTOMATION_ENABLED`/`AUTOMATION_CRON_SECRET` cases in `src/lib/env.test.ts`
— 94 new tests in total (including a targeted adversarial pre-merge audit
pass, see below), all against a real Postgres test database, zero
real network calls (the fake email provider from Phase 4 is reused, never
a real SMTP/vendor connection):
policy CRUD/versioning/validation, enrollment idempotency and eligibility
filtering, worker-vs-worker concurrency, repeated-tick idempotency,
catch-up (both a fresh deep-overdue sequence and a mid-lifecycle gap),
full/partial payment, cancellation, archived customer, policy-disabled,
pause, UNCERTAIN/stuck-SENDING blocking, `AUTO_SEND` (happy path,
payment-race-closes-before-send, concurrent-workers-single-send),
tenant isolation, and scheduler authentication (missing/wrong/correctly
formatted secret; unconfigured deployment).

## E2E

`src/server/collections/e2e.test.ts`, two full scenarios:

1. Register → organization → customer → overdue invoice → create/enable
   default policy → enable org automation → tick (enrolls) → tick (first
   step due, proposal created, nothing sent) → human approves and sends
   through the unmodified Phase 3/4 flow → payment recorded → tick
   (sequence self-heals to `COMPLETED`/`PAID`) → one more tick for good
   measure, still exactly one proposal and one communication ever
   created.
2. First reminder sent but delivery comes back `UNCERTAIN` (a simulated
   provider timeout) → next due step's tick is `blocked`, nothing sent,
   nothing created → a human manually resends with
   `acknowledgeUncertainRisk` and gets `SENT` → the following tick
   proceeds normally again.

## Verification

Actually run for this phase (not merely claimed): `npm run typecheck`,
`npm run lint`, `npm run db:validate`, `npm run test` (309/309 passing),
`npm run build`; a fresh-DB from-zero migration replay (dev + test
databases both re-applied the complete Phase 1–5 migration history, with
the Phase 5 CHECK constraints included, and reconciled via the same
`--create-only`-then-edit workflow Phase 2 established); the worker
concurrency, tenant isolation, fake-provider E2E, automation-disabled,
unauthorized-scheduler, payment-stop, cancellation-stop, partial-payment,
UNCERTAIN-block, repeated-tick, and catch-up scenarios all have dedicated
automated tests exercised in that same `npm run test` run, not a separate
manual pass. In addition, the UI was manually driven end-to-end in a real
browser (Playwright against a live `next dev` instance): sign up, create
an organization, create a customer, create an overdue invoice, enable
organization automation, create and enable the default policy, run the
dev-only manual tick, and confirm the invoice was enrolled with its first
step executed — visible both as a pending proposal in the Action Center
and as "Step 1 of 4" on the invoice detail page — followed by pausing and
resuming collections from that same page.

## UI

`/app/[orgSlug]/automation`:

- Organization automation kill switch (Enable/Disable, OWNER-only),
  with active-sequence / upcoming-action / blocked counts.
- Policy list: create-from-default-template, enable/disable, set-default,
  automation-mode toggle (all OWNER-only).
- Active sequences list: invoice/customer, a real status badge (Step N of
  M / Paused / Blocked — delivery uncertain), pause/resume/stop
  (OWNER-only).
- A manual "Run automation tick now" button, rendered **only** outside
  `NODE_ENV=production` and explicitly labeled "(dev only)" — see
  [No fake scheduler](#no-fake-scheduler).

Invoice detail page: a collections status block driven by
`getCollectionStatusForInvoice`, with distinct, honest copy per state —
"Collections completed — invoice paid", "Automation paused / Previous
email delivery status is uncertain — manual review required", "Collections:
active — Step N of M — next reminder at day +D overdue", "Collections:
paused" — plus an OWNER-only pause/resume control.

### No fake scheduler

This UI never claims "Automation running" as a statement about a real
external scheduler — it can only ever honestly say whether the
*organization* has opted in (`automationEnabled`) and whether the
*engine* is implemented (it always is, that's not conditional). Whether
anything actually invokes `runAutomationTick` on a recurring schedule in
a given deployment is a fact this application cannot observe from inside
itself, and the UI does not pretend otherwise — see
[Scheduler deployment](#scheduler-deployment) for how that gap is closed
operationally, and by whom.

## Scheduler deployment

Phase 5 does not hardcode a scheduler vendor into the domain — the
boundary is a single authenticated HTTP endpoint:

```
POST /internal/automation/tick
Authorization: Bearer <AUTOMATION_CRON_SECRET>
```

No request body. Returns `{ summary: AutomationTickSummary }` (`200`) on
success, `401` for a missing/wrong secret, `503` if the deployment hasn't
configured `AUTOMATION_ENABLED=true` and `AUTOMATION_CRON_SECRET` at all.

Any scheduler capable of an authenticated HTTPS POST on an interval can
drive this — Vercel Cron, a self-hosted `cron` + `curl`, a systemd timer,
a GitHub Actions scheduled workflow, another orchestrator entirely. None
of that is PAYNORA's concern; wiring one up is a deployment-configuration
task, not a code change. A reasonable interval is every 15–60 minutes —
frequent enough that a due step doesn't sit unattended for long, coarse
enough that a tick's own runtime (bounded by the per-organization query
strategy above) stays well under the interval even as the organization
count grows.

### Phase 11.6 audit: this section already was the production scheduler

Phase 11.6's brief asked for "a production-safe scheduled execution
path" — a target this section, `resolveTargetOrganizations`'s bounded
batching, `processOrganizationTick`'s per-organization failure
isolation, and the [Concurrency](#concurrency) section's compare-and-
swap guarantees already fully met, built in Phase 5 and hardened in
Phase 9 (P1-4 observability, P1-5 batching). No scheduler infrastructure
was added or duplicated in Phase 11.6; it audited this existing design
against a production-readiness checklist and found it already correct —
including at the exact concurrency edge cases the brief asked about (see
`engine.test.ts`'s `"two concurrent ticks execute the same due step
exactly once"` and `"concurrent tick invocations across the same batch
never duplicate a send"`). The one addition: an "Automation scheduler"
row in Settings → Readiness (`src/server/onboarding/readiness.ts`)
reporting whether `AUTOMATION_ENABLED`/`AUTOMATION_CRON_SECRET` are
configured for this deployment — see [Observability](#observability)
below.

## Observability

`runAutomationTick` returns and logs (`console.info`, one line per tick)
a structured, secret-free summary:

```json
{
  "globallyDisabled": false,
  "organizationsProcessed": 3,
  "scanned": 12,
  "enrolled": 2,
  "claimed": 4,
  "executed": 3,
  "skipped": 5,
  "stopped": 1,
  "blocked": 1,
  "failed": 0
}
```

Never logs an email body, AI provider credential, or the scheduler
secret. Per-invoice failures are logged separately (id + error name/
message only) without aborting the rest of that tick — one bad invoice
never blocks every other one. To answer "why didn't invoice X get its
next reminder," cross-reference that invoice's `CollectionSequence` (is
it `ACTIVE`?), its `CollectionStepExecution` rows (was the relevant step
claimed, executed, or skipped, and why — the `note` field says), and any
`Communication` on the invoice with `SENDING`/`UNCERTAIN` status (is it
blocked) — every one of those is a normal, queryable row, not something
only visible in a log line.

Two OWNER-visible surfaces build on this, without duplicating it: `GET
/internal/automation/health` (same bearer auth as the tick endpoint) is
the operational heartbeat for an external monitor — see
`src/server/collections/health.ts`. Settings → Readiness (Phase 11.4,
extended Phase 11.6) reports a simpler, configuration-only "Automation
scheduler: configured/disabled" signal for whoever is deciding whether to
turn automation on for their organization — it never queries
`AutomationTickRun` itself (that stays the health endpoint's job) and
never exposes `AUTOMATION_CRON_SECRET`.

## Performance

No `for each organization: for each invoice: query` pattern — see
[Scheduling](#per-organization-query-strategy) for the actual, bounded
per-organization query count. The one place this doesn't yet scale
perfectly: `listInvoicesWithFinancials(org, "all")` loads every invoice
for an organization into memory for one tick's eligibility pass. For an
organization with a genuinely huge invoice history (tens of thousands),
this becomes the bottleneck before anything else does. Phase 5 does not
solve this — it isn't needed at the current or reasonably foreseeable
scale, and solving it prematurely (e.g. paginating the eligibility scan,
or maintaining a separate "due soon" index table) would be exactly the
kind of complexity this project's stated philosophy warns against
building without proven necessity. Documented here as the known scaling
boundary, per the instruction to document rather than silently accept it.

## Rate safety

- One due logical step → at most one `Communication` — structurally, via
  `CollectionStepExecution`'s uniqueness (see
  [Concurrency](#concurrency)), not a rate limiter.
- At most one *newly executed* step per sequence per tick — catch-up
  semantics mean a tick never creates more than one new proposal/
  communication for a given invoice, regardless of how many steps are
  overdue.
- The organization automationEnabled kill switch is itself an
  emergency-pause mechanism — flipping it off stops all further
  automated action for that organization on the very next tick, with no
  separate "pause" feature needed for the emergency case.
- No enterprise rate-limiting platform was built — policy step count is
  capped at 20, `daysAfterDue` at 3650, both sane, documented bounds
  rather than a general-purpose limiter.

## Kill switch

Two independent switches, both required before anything external can
happen:

1. **Deployment-level** — `AUTOMATION_ENABLED` env var, default `false`.
   Checked first, before any database query: if false, `runAutomationTick`
   returns immediately with `globallyDisabled: true` and touches nothing.
2. **Organization-level** — `Organization.automationEnabled`, default
   `false`, OWNER-toggleable in the UI. Only organizations with this true
   are even selected for a global tick.

When either is off, every manual AR/Operator/Communication flow continues
working exactly as before Phase 5 existed — nothing in Phase 1–4 code
paths was touched.

## Env

`AUTOMATION_ENABLED` (`"true"`/unset, default unset → `false`) and
`AUTOMATION_CRON_SECRET` (required once `AUTOMATION_ENABLED="true"`, ≥20
characters) — Zod-validated in `src/lib/env.ts`, documented in
`.env.example`. Safe by construction: a deployment that never sets either
variable has automation fully inert, identical to pre-Phase-5 behavior.

## Exit readiness

A new owner, without talking to the original author, can: replace the
scheduler by pointing any authenticated-HTTPS-capable cron system at
`POST /internal/automation/tick` with a rotated secret; change the
default policy by editing `DEFAULT_POLICY_TEMPLATE` or, more commonly,
just creating a different policy and marking it default in the UI;
disable automation globally by unsetting `AUTOMATION_ENABLED` (or,
per-tenant, the org toggle); diagnose a stuck sequence by reading its
`CollectionSequence`/`CollectionStepExecution` rows directly (every
status has a plain-English reason, either in the row itself or this
document); and understand exactly why any given email was or wasn't sent
by reading [Observability](#observability). Nothing here depends on
undocumented tribal knowledge.

## Limitations

Documented, not silently accepted:

- The payment↔automation race has an irreducible small window between the
  final pre-send re-check and the actual provider call — see
  [Payment / cancellation safety](#payment--cancellation-safety).
- A crash between claiming a step and finalizing it leaves that step
  permanently un-retriable without human/admin intervention — see
  [Concurrency](#concurrency).
- A `POLICY_DISABLED`-stopped sequence does not auto-resume when the
  policy is re-enabled — a fresh, explicit decision (re-enrollment or a
  future dedicated "resume stopped sequences" action) is required.
- Enrollment only supports one default policy per organization for
  automatic enrollment — no per-invoice or per-customer policy
  assignment UI.
- `listInvoicesWithFinancials(org, "all")` loads a whole organization's
  invoices into memory per tick — see [Performance](#performance) for the
  documented scaling boundary.
- No outbox/reconciliation process for the crash-after-provider-success
  gap — same accepted limitation Phase 4 already documents, not
  reopened or re-solved here.

## Explicitly out of scope in Phase 5

Bank/accounting/CRM integrations, billing, Stripe/ЮKassa, Telegram/SMS/
WhatsApp, autonomous arbitrary AI actions, AI-generated financial
calculations, phone-based collections, legal debt collection, debt sale,
a visual workflow builder, a mobile app, inbound email, and a full
distributed queue/worker system — none of these were built, and none
were needed to satisfy Phase 5's actual requirements.
