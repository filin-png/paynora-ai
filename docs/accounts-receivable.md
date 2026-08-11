# Accounts Receivable Core (Phase 2)

This document describes what Phase 2 actually implemented: the
Customer/Invoice/Payment/ActivityEvent domain, and — most importantly —
the financial correctness decisions behind it. Read this before touching
`src/server/ar/*`; several choices there aren't self-explanatory from the
code alone.

## Money representation

Amounts are stored and computed exclusively as **integer minor units**
(kopecks, cents — whatever the currency's smallest unit is), never as a
JS floating-point number. `1000.00 USD` is `amountMinor = 100000n`.

**Storage type: `BigInt` (Postgres `BIGINT`/int8), not `Int`.** An earlier
draft of this phase used a 32-bit `Int` column (max 2,147,483,647 minor
units, ≈21.4M in major currency units). That was rejected during review as
an artificial cap unacceptable for a commercial B2B product — nothing
about accounts receivable should silently break because an invoice is
"too large." `BigInt` backs it with Postgres's 64-bit `BIGINT`
(±9,223,372,036,854,775,807 minor units, ≈92 quadrillion major units) —
effectively unbounded for this product. `amountMinorSchema` in
`src/server/ar/money.ts` bounds input to that column's actual ceiling; it
is a storage limit, not a business one.

**`bigint` never crosses a Server Action / Client Component boundary.**
Next.js's RSC serialization for `bigint` isn't something this codebase
relies on either way — every amount that crosses that boundary is a
`string`: a formatted display string (`formatMoney`) going out to a
Client Component, or a raw decimal string from a form (`amount` field)
coming back in. `parseAmountInput` converts the incoming string to
`bigint` using exact string/`BigInt` arithmetic — no floating-point step
at all, so it's exact for arbitrarily large amounts, not just ones a JS
`number` could represent safely. `formatMoney` does the reverse only for
*display*: it guards against `Number.MAX_SAFE_INTEGER` explicitly and
throws rather than silently losing precision, though no realistic amount
will ever approach that guard. Arithmetic and comparisons (outstanding,
overpayment checks, dashboard totals) stay in `bigint` on the server the
entire time in between — see `src/server/ar/money.test.ts` for tests
covering amounts well beyond the old Int32 ceiling.

## Currency model

`currency` is a 3-letter code (`SUPPORTED_CURRENCIES` in
`src/server/ar/currency.ts`: `RUB`, `USD`, `EUR`), validated against an
allowlist, not accepted as free text — a typo'd currency code would
silently break every calculation that groups by currency. Adding a
currency later is a one-line change to that array, not a migration.

**Currency lives on the Invoice, not the Payment.** A `Payment` has no
`currency` column at all — it always references exactly one `Invoice`
with a fixed currency, so "payment currency must match invoice currency"
isn't a runtime check to get right, it's an invariant eliminated by
construction: there is no field that could disagree.

**Totals are never combined across currencies.** The AR dashboard and
`getOrganizationArSummary` group every total by currency
(`CurrencyArSummary[]`, one entry per currency in use) — summing RUB and
USD into one number would be meaningless and silently wrong. FX
conversion is explicitly out of scope for Phase 2.

## Invoice numbering

`Invoice.number` is unique **per organization** (`@@unique([organizationId, number])`),
not globally — two different organizations can both have an "INV-0001".
The create-invoice form suggests the next number (`count + 1`, zero-padded)
but the field is freeform text the user can override — a deliberate
non-engine: this leaves room for imported invoices to keep an external
reference number without PAYNORA's suggestion getting in the way.

## Invoice lifecycle

**Persisted status has exactly two values: `OPEN` and `CANCELLED`.**
Everything else — paid, partially paid, overdue — is *derived*, computed
by `computeInvoiceFinancials()` in `src/server/ar/invoices.ts` from the
invoice's amount, its due date, and the sum of its payments. This was a
deliberate simplification: the original candidate list (Draft, Sent, Due,
Overdue, PromiseToPay, Paid, Cancelled) mixes states that are genuinely
independent facts (cancelled) with states that are just descriptions of
the payment/date data PAYNORA already has (paid, overdue) — persisting
the latter would create a second, driftable source of truth for something
already computable exactly. Phase 2 also has no draft/send workflow —
creating an invoice immediately issues it; a draft stage could be added
later as a nullable `issuedAt` field without breaking this model.

Derived states, evaluated together:

- **isPaid**: `status === OPEN && outstandingMinor <= 0`
- **isPartiallyPaid**: `status === OPEN && paidMinor > 0 && outstandingMinor > 0`
- **isOverdue**: `status === OPEN && outstandingMinor > 0 && dueDate < today`

A cancelled invoice is never paid, partially paid, or overdue — those
states only apply to open invoices. A fully paid invoice is never overdue,
even past its due date (see `src/server/ar/invoices.test.ts`).

**Cancellation** (`cancelInvoice`) is only permitted while
`paidMinor === 0` — an invoice with any recorded payment cannot be
cancelled through this path (see "Archival & deletion" below for why
there's no bypass).

## Outstanding balance

```
outstandingMinor = amountMinor − paidMinor
paidMinor        = SUM(payments.amountMinor WHERE invoiceId = X)
```

**Not persisted.** `getPaidMinorForInvoice` / `listInvoicesWithFinancials`
compute it from `Payment` rows on every read via a Postgres aggregate —
there is no `outstandingMinor` or `paidMinor` column on `Invoice` to drift
out of sync with reality. At Phase 2's scale (a small business's
customers and invoices), computing this live is cheap; the correctness
benefit of having exactly one source of truth outweighs any caching this
would otherwise justify. If this ever needs to become a persisted,
denormalized column for performance, it must be written only inside the
same transaction that writes the payment causing it to change, with the
transactional/locking strategy below — not before.

## Date semantics

`issueDate`, `dueDate`, and `paidAt` are **business dates**, not
timestamps — stored via Prisma's `@db.Date` (Postgres `date`, no
time-of-day, no timezone). Comparisons happen as `"YYYY-MM-DD"` strings
(`src/server/ar/dates.ts`), which sort lexicographically in calendar
order — this avoids the classic bug where a UTC/local offset pushes a
date across midnight and flips an overdue determination.

"Today" (`getBusinessToday()`) is the server's UTC calendar date. An
invoice becomes overdue the day **after** its due date — due-today is
still on time, not overdue. Accepted limitation: this is one global
"today," not a per-organization timezone; revisit only if that becomes a
real product requirement. `src/server/ar/dates.test.ts` and
`invoices.test.ts` cover the boundary cases explicitly: due today, one day
future, one day overdue, and month/year boundaries.

## Payment invariants

- **Amount must be positive** — enforced by `amountMinorSchema` (Zod) and
  the `payments_amount_positive` / `invoices_amount_positive` CHECK
  constraints at the database level (hand-added to the migration; Prisma's
  schema DSL has no portable way to declare a CHECK constraint — see the
  comment in `prisma/migrations/.../migration.sql`).
- **Tenant match**: `recordPayment(organizationId, invoiceId, ...)` looks
  up the invoice scoped to `organizationId`; a cross-tenant invoice id
  fails exactly like a nonexistent one (`ArResourceNotFoundError`).
- **Currency match**: eliminated by construction — see "Currency model."
- **No overpayment**: rejected, not silently clamped — see below.
- **Cancelled invoices reject payments** (`InvoiceCancelledError`).

### Overpayment policy

A payment that would push `outstandingMinor` below zero is rejected
outright (`OverpaymentError`), not partially applied or clamped. This was
a deliberate Phase 2 choice, not a placeholder: overpayment handling
(credit balance, refund, apply-to-next-invoice) is a real product decision
with no single obviously-correct default, so Phase 2 does the safe,
reversible thing — refuse it — rather than invent a policy nobody asked
for. Revisit if/when a real workflow needs it.

## Concurrency

Two operations against the same invoice at the same time must not be able
to produce an inconsistent result — neither "two payments jointly overpay
it" nor "an invoice ends up `CANCELLED` with a payment recorded against
it" — even though each operation individually looks valid against the
state it read. Every mutation that touches an invoice's financial state
(`recordPayment` in `payments.ts`, `cancelInvoice` in `invoices.ts`) goes
through the same row-level lock, `lockInvoiceForUpdate`
(`src/server/ar/invoices.ts`), not just an application-level check:

```sql
SELECT id, "organizationId", ..., "amountMinor", status
FROM invoices
WHERE id = $1 AND "organizationId" = $2
FOR UPDATE
```

This runs inside `prisma.$transaction`, via `tx.$queryRaw` (verified to
return a native `bigint` for the `amountMinor` column, not a string — see
the money-representation section above on why that matters). The lock is
held for the transaction's duration: a second concurrent call against the
same invoice — whether it's another payment or a cancellation — blocks at
this `SELECT ... FOR UPDATE` until the first transaction commits, then
re-reads the now-current state before deciding anything. Both operations
re-check what they care about only *after* acquiring the lock, never from
a value read before the transaction started:

- `recordPayment` re-reads the paid total and re-checks `status` — an
  invoice cancelled by a transaction that committed first is correctly
  seen as `CANCELLED` and the payment is rejected
  (`InvoiceCancelledError`), not silently recorded against a cancelled
  invoice.
- `cancelInvoice` re-reads the paid total *inside* the lock — a payment
  that committed first is correctly seen in the sum, and the cancellation
  is rejected (`InvoiceHasPaymentsError`), not applied on top of a stale
  "no payments yet" read.

Whichever operation reaches the lock first determines the outcome; the
other is rejected. There is no interleaving that leaves the invoice in a
state where both a cancellation and a payment "took."

This is exercised directly, not just documented:

- `src/server/ar/payments.test.ts` fires two real concurrent
  `recordPayment` calls (`Promise.allSettled`) for amounts that
  individually fit but together would overpay, and asserts exactly one
  succeeds, the other is rejected with `OverpaymentError`, and the final
  outstanding balance is correct and non-negative.
- `src/server/ar/invoices.test.ts` fires a concurrent `cancelInvoice` and
  `recordPayment` against the same invoice and asserts, whichever one
  wins: exactly one of the two succeeds, and the final persisted state is
  never `CANCELLED` with a nonzero paid amount — proving the actual
  locking mechanism, not a mocked stand-in for it.

## Activity timeline

`ActivityEvent` is a pragmatic, append-only log — not event sourcing.
Rows are written, never updated or deleted, alongside the change they
describe (usually in the same transaction, so an event and the change it
records either both commit or both roll back). Each row carries a
precomputed human-readable `summary` plus optional `metadata` (JSON) for
future structured use; `customerId`/`invoiceId` are nullable FKs so an
event can relate to either or both. Recorded events, Phase 2: customer
created/updated/archived, invoice created/cancelled, payment recorded,
invoice fully paid. The model is intentionally reusable for Phase 3+
(reminders, payment promises, automation actions) without a redesign —
just new `ActivityEventType` values.

Activity is tenant-owned like every other Phase 2 entity: listing
functions (`listOrganizationActivity`, `listInvoiceActivity`,
`listCustomerActivity`) all take `organizationId` and never return another
tenant's rows — see `src/server/ar/activity.test.ts`.

## Archival & deletion

- **Customers** are archived (`archivedAt` timestamp), never deleted.
  Archiving excludes them from `listCustomers()`'s default view and from
  the invoice-creation customer picker, but does **not** touch their
  existing invoices or payments — those remain fully visible and payable,
  because archiving a customer must never make it impossible to collect
  money still owed by them.
- **Invoices with payments cannot be cancelled** (see "Invoice lifecycle")
  and there is no invoice delete operation at all — `Invoice.customerId`'s
  foreign key is `ON DELETE RESTRICT`, so a customer with invoice history
  cannot be hard-deleted even by a future code path that forgets this
  document.
- **Payments have no edit or delete operation.** Phase 2 does not
  implement payment correction/reversal (e.g., "recorded the wrong
  amount") — that is deferred, not silently allowed via an unrestricted
  delete. `Payment.invoiceId`'s foreign key is `ON DELETE RESTRICT` for
  the same reason as above.

## AR dashboard

`getOrganizationArSummary` and `getInvoicesRequiringAttention`
(`src/server/ar/summary.ts`) are the only two functions the dashboard
calls — both real, both computed from persisted data, no fabricated
numbers. "Requiring attention" is a **deterministic, non-AI** definition
for this phase: overdue open invoices (sorted most-overdue first), then
open invoices due within the next 7 days — both still outstanding, fully
paid invoices excluded either way. Phase 3 may layer AI risk scoring on
top of this; it does not replace it.
