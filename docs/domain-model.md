# Domain Model

**Status: design direction for Phase 1–2. Nothing described here is
implemented yet** — there are no Prisma models beyond the empty
datasource/generator declaration in `prisma/schema.prisma`. This document
exists so Phase 1 has a shared target instead of inventing the domain
ad hoc, and so it isn't confused with a description of shipped
functionality.

## Conceptual flow

```
Organization → Customers → Invoices → Risk Analysis → Collection Actions → Payment → Analytics
```

## Entities

- **User** — an authenticated application user. Can belong to more than one
  Organization.
- **Organization** — the tenant. All business data belongs to exactly one
  Organization. This is the unit of billing and of data isolation.
- **OrganizationMembership** — join between User and Organization. Designed
  to carry a role from the start (e.g. owner/admin/member) even though
  Phase 1 may ship with a single implicit role.
- **Customer** — a debtor/client belonging to an Organization.
- **Invoice** — issued to a Customer. Tracks amount, currency, issue date,
  due date, outstanding amount, payment status, and collection status.
  **Lifecycle states are not finalized.** The brief lists Draft, Sent, Due,
  Overdue, PromiseToPay, Paid, Cancelled as candidates, but Phase 2 must
  evaluate the actual domain invariants (e.g. can an invoice be both
  "Overdue" and have an active "PromiseToPay"? is status derived from dates
  or explicitly set?) before encoding a state machine. Do not treat the
  candidate list as final.
- **Payment** — payment information associated with one or more invoices.
  Must support partial payments from the start of Phase 2, even if the UI
  ships full-payment-only first — retrofitting partial payments into a
  full-payment-only schema is expensive.
- **Reminder** — a piece of collection communication tied to an invoice.
- **CollectionSequence** — rules describing when reminders fire relative to
  an invoice's due date.
- **CommunicationEvent** — history of communication/activity relevant to a
  customer or invoice (superset of Reminder — also covers manual notes,
  status changes, payment events).
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
