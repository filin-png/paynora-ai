# Domain Model

**Status: User, Organization, OrganizationMember (Phase 1); Customer,
Invoice, Payment, ActivityEvent (Phase 2); and BusinessEvent,
OperatorInsight, ActionProposal (Phase 3) are implemented** — see
`prisma/schema.prisma`, `docs/identity-and-tenancy.md`,
`docs/accounts-receivable.md`, and `docs/operator-foundation.md` for the
actual schemas and design rationale. Everything else below
(CollectionSequence, PaymentPromise, Subscription) is design direction
for Phase 4+, not implemented yet. This document exists so later phases
have a shared target instead of inventing the domain ad hoc.

## Conceptual flow

```
Organization → Customers → Invoices → Risk Analysis → Collection Actions → Payment → Analytics
```

Phase 3 implements the "Risk Analysis → Collection Actions" step up to
the point of human approval:

```
Invoice (overdue) → BusinessEvent → OperatorInsight → ActionProposal → human approval
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
- **ActionProposal** *(implemented, Phase 3)* — a proposed action
  (`SEND_PAYMENT_REMINDER` is the only type Phase 3 allows) awaiting human
  approval or dismissal. `EXECUTED`/`FAILED` statuses exist in the schema
  for a future phase's execution step but are not reachable yet — Phase 3
  never sends anything, even after approval. See
  `docs/operator-foundation.md#action-safety` and `#approval-workflow`.
- **Reminder** — the actual collection communication (subject/body,
  delivery channel, send status) sent once an `ActionProposal` is
  approved. Not modeled yet — Phase 4, once there's an `EmailProvider` to
  send through.
- **CollectionSequence** — rules describing when reminders fire relative to
  an invoice's due date. Phase 4.
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
