# Proactive Financial Operations (Phase 16)

Phase 16 extends the existing Operator pipeline
(`BusinessEvent -> OperatorInsight -> ActionProposal`, see
`docs/operator-foundation.md`) with a read-time proactive layer: an
explainable attention score, three new deterministic detectors, a Daily
Brief aggregation, customer payment-behavior trends, cash-flow risk
windows, outcome tracking, and a small grounded Copilot. Nothing here
replaces the Phase 3 pipeline or introduces a second one — every new piece
either feeds it (new detectors) or reads from data it and the AR layer
already produce (attention score, briefing, trends, outcomes, Copilot).

This document covers both the backend (merged to `main` in PR #22) and the
UI layer built on top of it in this phase — the Overview "Today" section,
Action Center attention/stale display, invoice list priority badges, and
the customer detail trend card.

## Why "proactive", and why not a second pipeline

The Phase 3 Operator already turns overdue invoices into reminders a human
approves. What it didn't do: explain *why* one overdue invoice deserves
attention before another, surface risk that hasn't become an overdue
invoice yet (a customer paying slower every month, cash expected next week
that historically doesn't arrive on time), or let a human ask a small set
of grounded questions about what's going on instead of reading raw tables.
Phase 16 answers those without touching how a reminder gets proposed,
approved, or sent — that state machine (`docs/operator-foundation.md`
#approval-workflow) is unchanged.

## Architecture: detectors -> attention score -> briefing -> copilot -> proposal

```
BusinessEvent detectors (events.ts)
  INVOICE_OVERDUE ─────────────┐
  PAYMENT_RECEIVED             │
  INVOICE_RISK_ESCALATED       │  all insight-only except
  CUSTOMER_PAYMENT_BEHAVIOR_   │  INVOICE_OVERDUE
  DETERIORATED                 │
        │                      │
        ▼                      ▼
  OperatorInsight        ActionProposal (SEND_PAYMENT_REMINDER)
   (insights.ts)          (proposals.ts, unchanged from Phase 3)
        │
        ▼
  read-time aggregation layer (nothing persisted below this line)
   ├─ attention/score.ts        — explainable 0..100 score, pure function
   ├─ attention/for-invoices.ts — bulk score lookup for a known invoice set
   ├─ customer-intelligence/    — payment-delay trend (per customer)
   ├─ briefing/daily-brief.ts   — Overview "Today" aggregation
   ├─ briefing/cash-flow-risk.ts
   ├─ briefing/what-changed.ts
   ├─ operator/outcomes.ts      — outcome/effectiveness history
   ├─ notifications/policy.ts   — notification-worthiness decision (no delivery wired up yet)
   └─ copilot/service.ts        — small, fixed-question grounded Copilot
        │
        ▼
  UI (Overview "Today", Action Center, invoice list, customer detail)
```

Every box below "read-time aggregation layer" is computed fresh on every
call from data that already exists — `BusinessEvent`, `OperatorInsight`,
`ActionProposal`, `Invoice`, `Payment`. None of it is a second source of
truth, and none of it is trained or persisted as a model.

### Detectors (`src/server/operator/events.ts`)

Three detectors were added alongside the existing `INVOICE_OVERDUE`:

- `PAYMENT_RECEIVED` — a payment was recorded. Always LOW priority; this is
  good news, not something needing a decision.
- `INVOICE_RISK_ESCALATED` — an overdue invoice crossed into a new
  overdue-days bucket (the same `computeOverduePriority` buckets the
  Phase 3 insight priority already uses: LOW < 7 days, MEDIUM 7-29,
  HIGH >= 30). Raises visibility on an invoice `INVOICE_OVERDUE` already
  proposed a reminder for — it does **not** create a second proposal.
- `CUSTOMER_PAYMENT_BEHAVIOR_DETERIORATED` — a customer's recent average
  payment delay increased by at least 3 days versus their previous window
  (`customer-intelligence/trends.ts`). Always MEDIUM priority.

All three are insight-only by design (see the doc comments in `events.ts`
and `pipeline.ts`): reusing `SEND_PAYMENT_REMINDER` for them would either
duplicate the reminder already pending for the same invoice, or have no
real action type to propose for a customer-level signal that isn't tied to
one invoice. Every detector is idempotent via the same DB unique
constraint pattern as `INVOICE_OVERDUE` — see
`docs/operator-foundation.md#idempotency`.

### Attention score (`src/server/attention/score.ts`) {#attention-priority}

`computeAttentionScore` is a pure, DB-free function producing a 0-100
score from four weighted factors:

| Factor | Max points | What it measures |
| --- | --- | --- |
| Outstanding amount | 30 | This invoice's balance relative to the largest in the batch being scored |
| Days overdue | 40 | Overdue days, saturating at 30 days |
| Insight priority | 20 | The same LOW/MEDIUM/HIGH bucket `computeOverduePriority` already assigns |
| Has an unresolved action | 10 | Whether this invoice already has a pending `ActionProposal` |

Every factor that contributed is returned alongside the total — nothing
about the score is a black box, and the UI's "why does this need
attention" text (`explainAttentionScore` in
`src/components/ui/attention-score.tsx`) is built directly from these
factors, never a separate explanation that could drift from the number.

`src/server/attention/for-invoices.ts` adds a bulk lookup,
`getAttentionScoresForInvoiceIds`, for screens that already know which
invoices they care about (Action Center) instead of scanning every
overdue invoice the way the Daily Brief does. It reuses the exact same
`computeAttentionScore`/`computeOverduePriority` pair — there is only one
scoring implementation.

### Daily Brief (`src/server/briefing/daily-brief.ts`) {#daily-brief}

`getDailyBrief(organizationId)` is the single entry point behind the
Overview "Today" section. It aggregates, all at read time:

- `attentionItems` — the top 5 overdue invoices by attention score, each
  with the full `AttentionScore` (score + factors) attached.
- `recommendedActionsCount` — the count of pending `ActionProposal`s.
- `cashFlowRiskWindows` — see below.
- `whatChanged` — see below.

Nothing here is persisted; calling it twice in a row recomputes everything
from the same sources `getInvoicesRequiringAttention`,
`listPendingActionProposals`, and `getOrganizationArSummary` already
expose elsewhere in the app.

### Cash-flow risk windows (`src/server/briefing/cash-flow-risk.ts`) {#cash-flow-risk-windows}

For each of the next 3 weeks: "expected" is the total of currently-open,
not-yet-due invoices whose due date falls in that week — real, scheduled
money, never invented. "Estimated at risk" multiplies that by this
organization's *own* historical overdue rate (how much of everything
currently outstanding is overdue right now). A week is flagged
(`isPotentialRisk`) only when there's real expected inflow **and** the
org's own overdue rate is at least 25% — never a guess with no data behind
it. There was no forward-looking cash-flow forecast in this codebase
before Phase 16 (`getReceivablesTrend` is historical, trailing 14 days) —
this is new functionality, not an extension of an existing forecast.

### What changed (`src/server/briefing/what-changed.ts`) {#what-changed}

Every item comes from a real, already-persisted timestamp —
`Payment.createdAt`, `BusinessEvent.detectedAt`, `ActivityEvent.createdAt`
— over a lookback window (24h for the Overview section, 7 days for the
Copilot's `what_changed_this_week`). Nothing is inferred; a quiet
organization gets an honest "nothing changed" rather than a filler
sentence.

### Customer payment-behavior trends (`src/server/customer-intelligence/trends.ts`) {#customer-trends}

Compares a customer's most recent 3 payments' delay-vs-due-date against
the 3 before those. Below 2 payments in either window, the result is
always `insufficient-history` — never an invented direction. A delta of
+/-3 days moves the status to `deteriorating`/`improving`; otherwise
`stable`. `getCustomerPaymentTrend` (single customer, used by the customer
detail page and the Copilot) and `getAllCustomerPaymentTrends` (bulk, used
by the `CUSTOMER_PAYMENT_BEHAVIOR_DETERIORATED` detector) share the same
pure `computeTrendFromDelays` — one trend algorithm, two query shapes.

### Outcomes and effectiveness (`src/server/operator/outcomes.ts`) {#outcomes-and-effectiveness}

`getActionOutcome`/`getRecommendationEffectiveness` report whether a
payment was recorded after a proposal was executed, and how many days
later — derived entirely from existing timestamps, never trained or
persisted separately. Language is deliberately neutral: "payment received
after action," never "action caused the payment" — this is a history, not
a causal claim, and nothing in this phase's UI surfaces a causality claim
either.

### Notification policy (`src/server/notifications/policy.ts`)

A pure decision function — "is this business event worth interrupting
someone for" — with no delivery mechanism wired up in this phase. It
exists so a future notification channel (email digest, push, Telegram)
has one policy to call rather than each channel inventing its own
worthiness rule. Out of scope for Phase 16's UI: nothing in this phase
sends a notification.

### Proactive Copilot (`src/server/copilot/service.ts`) {#proactive-copilot}

A small, fixed set of five pre-defined questions
(`why_important`, `explain_customer`, `what_changed_this_week`,
`focus_invoices`, `cash_flow_risk`) — **never a free-text chat box**. Every
question has a known, deterministic grounding query, so there is no
user-authored prompt surface for injection to exploit (see
docs/operator-foundation.md#prompt-injection-defense for the same
fixed-system-prompt/structured-input pattern this reuses), and no risk of
answering a question PAYNORA has no real data to support. Every answer
always has a `deterministicAnswer`; AI, if enabled and successful, may
only reword it (`elaborate`), validated against a schema before being
trusted at all — identical in shape to how `insights.ts` already lets AI
reword a reminder summary. This phase's UI does not yet call the Copilot
directly (no chat surface was built) — the deterministic building blocks
it depends on (attention score, trends, what-changed, cash-flow risk) are
the same ones the Overview "Today" section and customer detail page
render directly, so a future Copilot UI has nothing left to wire beyond
the question-asking surface itself.

## Deterministic fallback

Every piece of Phase 16 that could involve AI has an always-available
deterministic answer computed first, with AI (if enabled, quota-permitting,
and successful) only ever allowed to reword that answer — never to add,
remove, or change a fact, a priority, or a financial figure:

- `ensureInsightForInvoiceOverdueEvent` — deterministic summary always
  built first; AI may only replace the wording, validated against
  `reminderInsightOutputSchema`.
- `ensureInsightForPaymentReceivedEvent` /
  `ensureInsightForCustomerBehaviorEvent` — deliberately never call AI at
  all; both are informational, so a fixed deterministic summary is already
  the whole answer.
- Copilot `answerCopilotQuestion` — same pattern as the insight summary:
  deterministic first, AI only rewords, validated before use.

If AI is disabled (the test/CI default and this phase's own environment —
no production AI credentials were connected while building this), every
one of these still produces a complete, correct answer. This was verified
by running the full test suite with AI disabled (the default) rather than
mocking a provider response.

## Security boundaries

- **Tenant isolation.** Every new function takes `organizationId` and
  threads it into every query — `getAttentionScoresForInvoiceIds` scopes
  its bulk invoice lookup by `organizationId AND id IN (...)`, so even an
  invoice id from another tenant passed in by mistake would simply not
  match. `getCustomerPaymentTrend`, `getDailyBrief`,
  `getCashFlowRiskWindows`, and the Copilot all scope their underlying
  queries by `organizationId` the same way every existing AR/Operator
  query in this codebase does. See `docs/operator-foundation.md` and
  `SECURITY.md` for the project-wide tenant-isolation discipline this
  follows, not reinvents.
- **AI never sends anything, never proposes anything new.** Phase 16 adds
  zero new action types and zero new send paths. The approval state
  machine (`docs/operator-foundation.md#approval-workflow`) is completely
  unchanged: a human still explicitly approves, and sending a communication
  is still a separate, explicit step after that (`docs/communications.md`).
  The Action Center UI added in this phase (attention score, Stale
  display) is read-only decoration on top of that existing flow — the
  approve/dismiss forms themselves were not touched.
- **No new user-authored AI input surface.** The Copilot's fixed question
  set means there is no free-text box anywhere in Phase 16 whose content
  reaches an AI prompt — the same defense-in-depth reason Phase 3's
  insight generation only ever sends deterministic, already-validated
  invoice facts to the model, never raw user input.
- **No production credentials connected.** This phase (backend and UI) was
  built and tested entirely with AI disabled and no live provider
  credentials — every deterministic fallback path above is what actually
  ran during development and in the test suite.

## UI surfaces (this phase)

- **Overview -> "Today"** (`src/app/app/[orgSlug]/page.tsx`): a new
  section between the onboarding checklist and the currency summary,
  showing up to 5 attention-scored overdue invoices (score badge, the top
  contributing factors in plain language, and a next-step line — "a
  reminder is already proposed" or "run Check for new actions"), the next
  3 weeks of cash-flow risk, and what changed in the last 24 hours. Each
  panel has its own honest empty state; nothing here duplicates the
  existing "Top overdue invoices" table or "Recent activity" feed below
  it — those already existed and still show their own thing (most-overdue
  list, raw activity log).
- **Action Center** (`src/app/app/[orgSlug]/actions/page.tsx`): each
  pending proposal now also shows its attention score next to the existing
  priority badge, and a one-line caption ("Detected automatically
  {date} — this proposal follows directly from that insight") making the
  insight -> proposal link explicit. "Recently decided" now also lists
  `STALE` proposals (previously silently excluded — see
  `listRecentlyDecidedActionProposals` in `approval.ts`) with a neutral
  "Stale — no longer needed" badge, so a proposal the system auto-resolved
  (the invoice was paid before a human decided) doesn't just disappear.
  The approve/dismiss forms and the underlying state machine are
  byte-for-byte unchanged — this is decoration on an existing flow, not a
  new one.
- **Invoices list** (`src/app/app/[orgSlug]/invoices/page.tsx`): a new
  "Priority" column for overdue invoices only, reusing
  `computeOverduePriority` (the same function Operator insights already
  use — not a second calculation), plus a subtle red left-border accent on
  HIGH-priority rows. The list's sort order and cursor pagination
  (`docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md` P1-6) were deliberately
  left unchanged — re-sorting by priority would break the cursor's
  gap-free pagination guarantee, so this phase highlights instead of
  reorders. See "Known limitations" below.
- **Customer detail** (`src/app/app/[orgSlug]/customers/[customerId]/page.tsx`):
  a new "Payment behavior trend" card calling `getCustomerPaymentTrend`
  directly — one query, no duplication — showing the same
  improving/deteriorating/stable/insufficient-history states the
  `CUSTOMER_PAYMENT_BEHAVIOR_DETERIORATED` detector and the Copilot's
  `explain_customer` answer already use.

## Known limitations

- The invoices list highlights priority visually rather than re-sorting by
  it, to preserve the existing cursor-pagination invariant. A future phase
  could add an explicit "sort by priority" option that switches to
  offset-based pagination for that view only, if this is worth the added
  complexity.
- The Copilot's five questions are not yet exposed through a dedicated UI
  surface (no chat box or "ask" button was built in this phase) — its
  deterministic building blocks are surfaced directly instead (the
  Overview "Today" section, the customer trend card). A future phase can
  add a thin UI wrapper around `answerCopilotQuestion` without touching
  the service itself.
- The notification-worthiness policy (`notifications/policy.ts`) has no
  delivery channel wired to it yet — it's a decision function only.
- No production AI or messaging credentials were connected while building
  this phase; every path above was exercised through its deterministic
  fallback, not a live provider call.
