# Domain Model

**Status: User, Organization, OrganizationMember (Phase 1); Customer,
Invoice, Payment, ActivityEvent (Phase 2); BusinessEvent,
OperatorInsight, ActionProposal (Phase 3); and Communication,
DeliveryAttempt (Phase 4) are implemented** — see `prisma/schema.prisma`,
`docs/identity-and-tenancy.md`, `docs/accounts-receivable.md`,
`docs/operator-foundation.md`, and `docs/communications.md` for the
actual schemas and design rationale. Everything else below
(CollectionSequence, PaymentPromise, Subscription) is design direction
for Phase 5+, not implemented yet. This document exists so later phases
have a shared target instead of inventing the domain ad hoc.

## Conceptual flow

```
Organization → Customers → Invoices → Risk Analysis → Collection Actions → Payment → Analytics
```

Phase 3 implements "Risk Analysis → Collection Actions" up to human
approval; Phase 4 carries it through to a real sent email:

```
Invoice (overdue) → BusinessEvent → OperatorInsight → ActionProposal
  → [approve] → Communication draft → [review/edit] → [Send] → EmailProvider
  → DeliveryAttempt → Communication SENT → ActionProposal EXECUTED
```

## Entities

- **User** *(implemented)* — an authenticated application user. Can belong
  to more than one Organization.
- **Organization** *(implemented)* — the tenant. All business data belongs
  to exactly one Organization. This is the unit of billing and of data
  isolation.
- **OrganizationMember** *(implemented)* — join between User and
  Organization, carrying a role (`OWNER` | `MEMBER`) from the start. See
  `docs/identity-and-tenancy.md` for why only two roles exist so far and
  how the architecture leaves room for more without a redesign.
- **Customer** *(implemented)* — a debtor/client belonging to an
  Organization. Archived (`archivedAt`), never deleted — see
  `docs/accounts-receivable.md#archival--deletion`.
- **Invoice** *(implemented)* — issued to a Customer. Tracks amount
  (integer minor units, `BigInt`), currency, issue date, due date, and
  notes. Only `OPEN`/`CANCELLED` are persisted status values; outstanding
  amount, paid/partially-paid, and overdue are all *derived*, not stored —
  see `docs/accounts-receivable.md#invoice-lifecycle` for why the original
  Draft/Sent/Due/Overdue/PromiseToPay/Paid/Cancelled candidate list was
  not encoded as-is.
- **Payment** *(implemented)* — amount and date against exactly one
  invoice; multiple payments per invoice and partial payments are
  supported from the schema up, with an explicit overpayment-rejection
  policy protected under concurrency — see
  `docs/accounts-receivable.md#concurrency`. No currency field of its own
  (inherits the invoice's).
- **ActivityEvent** *(implemented)* — the append-only audit log Phase 2
  actually built; covers what the brief's Reminder/CommunicationEvent
  concepts below describe, and Phase 3 extended it (two new
  `ActivityEventType` values, no new model) to also audit Operator
  approval/dismissal decisions — see
  `docs/accounts-receivable.md#activity-timeline` and
  `docs/operator-foundation.md#approval-workflow`.
- **BusinessEvent** *(implemented, Phase 3)* — a deterministically
  detected fact about the business (Phase 3: only `INVOICE_OVERDUE`).
  Never an AI opinion; idempotent per `[organizationId, type, dedupeKey]`.
  See `docs/operator-foundation.md#the-pipeline`.
- **OperatorInsight** *(implemented, Phase 3)* — a structured
  interpretation of one `BusinessEvent`: a deterministically computed
  `priority` plus a summary that is deterministic by default and may be
  AI-enriched (wording only, schema-validated) when AI is enabled. One per
  `BusinessEvent`.
- **ActionProposal** *(implemented, Phase 3, extended Phase 4)* — a
  proposed action (`SEND_PAYMENT_REMINDER` is the only type allowed)
  awaiting human approval or dismissal. `EXECUTED` is reachable starting
  Phase 4 — set only after a `Communication`'s send is *confirmed*
  successful, never on approval and never on an ambiguous outcome.
  `FAILED` remains unreachable — a failed/uncertain send leaves the
  proposal `APPROVED`; failure belongs to the `Communication`/
  `DeliveryAttempt` history, which can be retried. See
  `docs/operator-foundation.md#action-safety`,
  `docs/communications.md#action-proposal-integration`.
- **Communication** *(implemented, Phase 4)* — the "Reminder" concept
  from earlier drafts of this document, actually built: one email
  (`channel: EMAIL`, `purpose: PAYMENT_REMINDER` — the only members of
  each enum) drafted for exactly one approved `ActionProposal`
  (`@unique` on `actionProposalId`). Recipient/subject/body are
  snapshotted and frozen once sending starts — see
  `docs/communications.md#state-machine`.
- **DeliveryAttempt** *(implemented, Phase 4)* — one row per actual
  dispatch attempt (initial send or retry), never overwritten, so the
  full attempt history survives any number of retries. See
  `docs/communications.md#delivery-semantics` for why this exists instead
  of a single mutable "last attempt" field on `Communication`.
- **CollectionSequence** — rules describing when reminders fire relative
  to an invoice's due date, and the scheduling to fire them
  automatically. Phase 4 deliberately built only the manual, one-at-a-time
  send path (`docs/communications.md#explicitly-out-of-scope-in-phase-4`);
  sequencing/automation is a later phase.
- **PaymentPromise** — a customer's promise to pay by a specific date.
  Manual entry first (Phase 5); automatic extraction from replies is a
  later capability layered on top via the AI provider.
- **Subscription** — PAYNORA's own commercial subscription for an
  Organization (billing for using PAYNORA, not a Customer's payment).
  Domain boundaries should not make this hard to add later, but billing
  logic itself is Phase 6.

## Multi-tenancy

Every entity except `User` is scoped to exactly one `Organization`
(directly or transitively). Tenant isolation is enforced at the data-access
layer, not left to the UI or to callers remembering to filter — see
`ARCHITECTURE.md` and `SECURITY.md`.
