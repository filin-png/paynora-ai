# Domain Model

**Status: User, Organization, OrganizationMember (Phase 1), and Customer,
Invoice, Payment, ActivityEvent (Phase 2) are implemented** — see
`prisma/schema.prisma`, `docs/identity-and-tenancy.md`, and
`docs/accounts-receivable.md` for the actual schemas and design
rationale. Everything else below (Reminder, CollectionSequence,
PaymentPromise, AutomationEvent, Subscription) is design direction for
Phase 3+, not implemented yet. This document exists so later phases have
a shared target instead of inventing the domain ad hoc.

## Conceptual flow

```
Organization → Customers → Invoices → Risk Analysis → Collection Actions → Payment → Analytics
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
  concepts below describe, and is designed to extend to them (and to
  AutomationEvent) without a schema redesign — see
  `docs/accounts-receivable.md#activity-timeline`.
- **Reminder** — a piece of collection communication tied to an invoice.
- **CollectionSequence** — rules describing when reminders fire relative to
  an invoice's due date.
- **CommunicationEvent** — history of communication/activity relevant to a
  customer or invoice (superset of Reminder — also covers manual notes,
  status changes, payment events). Phase 2's `ActivityEvent` already covers
  this ground for AR events; Phase 4 extends it for communication/reminder
  events specifically rather than introducing a separate model.
- **PaymentPromise** — a customer's promise to pay by a specific date.
  Manual entry first (Phase 5); automatic extraction from replies is a
  later capability layered on top via the AI provider, not a Phase 2/3
  requirement.
- **AutomationEvent** — record of an automated collection action taken by
  the system, distinct from CommunicationEvent in that it specifically
  tracks *what the automation did and why*, for observability and
  debugging of the automation itself.
- **Subscription** — PAYNORA's own commercial subscription for an
  Organization (billing for using PAYNORA, not a Customer's payment).
  Domain boundaries should not make this hard to add later, but billing
  logic itself is Phase 6.

## Multi-tenancy

Every entity except `User` is scoped to exactly one `Organization`
(directly or transitively). Tenant isolation is enforced at the data-access
layer, not left to the UI or to callers remembering to filter — see
`ARCHITECTURE.md` and `SECURITY.md`.
