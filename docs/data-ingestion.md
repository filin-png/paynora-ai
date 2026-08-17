# Financial Data Ingestion Foundation (Phase 10.2)

This document describes the bulk-import path added in Phase 10.2: CSV
import of customers and invoices, plus the source-neutral boundary it's
built on so a future source (bank feed, accounting/ERP export, an
inbound API) doesn't require rewriting anything under `src/server/ar/`.
Read this before touching `src/server/ingestion/*`.

## Scope

Customer and invoice bulk import only. Payments, bank sync, ERP/
accounting integrations, and webhooks are explicitly out of scope for
this phase — see the module-level comments in `src/server/ingestion/`
for what's deliberately not built yet.

## Architecture

```
CSV text
  -> parseCsvText            (src/server/ingestion/csv/parse.ts)     — SOURCE PARSING, no domain knowledge at all
  -> parseCustomerCsv/       (src/server/ingestion/csv/customers.ts,
     parseInvoiceCsv          src/server/ingestion/csv/invoices.ts)  — NORMALIZATION: CSV column names -> canonical fields
  -> importCustomers/        (src/server/ingestion/customers.ts,
     importInvoices           src/server/ingestion/invoices.ts)      — VALIDATION + IMPORT/WRITE, source-neutral
  -> createCustomer/createInvoice (src/server/ar/*)                  — the exact same functions the manual forms call
```

**The boundary that matters is `NormalizedCustomerRecord`/
`NormalizedInvoiceRecord`** (`src/server/ingestion/types.ts`) — a plain,
string-keyed shape with no CSV-specific concept (no column index, no
"row text"). `importCustomers`/`importInvoices` only ever see these
records; they have never heard of CSV. A future adapter — say, a bank
statement API — would live in `src/server/ingestion/bank/` (or wherever),
produce the same normalized records, and call the exact same
`importCustomers`/`importInvoices`. Nothing under `src/server/ar/` was
touched to build this — CSV parsing was deliberately kept out of AR
domain logic entirely.

**Deliberately not built:** a generic "data source" interface/registry,
a plugin system, or any other abstraction with only one real
implementation behind it. The directory split (`csv/` vs. the
entity-level files) *is* the abstraction; formalizing it further before
a second source actually exists would be guessing at requirements no one
has yet.

## Why reuse `createCustomer`/`createInvoice` instead of writing rows directly

Every invariant those two functions already enforce — `customerInputSchema`
/`invoiceInputSchema` validation, the `(organizationId, number)` uniqueness
constraint, `dueDate >= issueDate`, the `CUSTOMER_CREATED`/`INVOICE_CREATED`
activity events, tenant scoping — is inherited for free, with a single
implementation to keep correct. An imported customer or invoice is
completely indistinguishable from a manually-created one: same schema
validation, same audit trail, same eligibility for every downstream
system (AR dashboard, Action Center, Collections Automation) that reads
from `Customer`/`Invoice` with no idea whether a row came from a form or
an import. `enrollEligibleInvoices` (`src/server/collections/enrollment.ts`)
was already written with this in mind — its own doc comment names
bulk-imported invoices as the reason it re-scans for enrollment-eligible
invoices instead of only reacting to a create event.

## Money conversion

CSV amounts are parsed with `parseAmountInput`
(`src/server/ar/money.ts`) — the exact same exact-string/`BigInt`
arithmetic function `RecordPaymentForm` already uses, not a new parser.
No floating-point step, ever. It already rejects: malformed strings, more
than 2 decimal places, and (by construction — the pattern has no `-`) a
negative sign. `amountMinorSchema` (applied via `invoiceInputSchema`)
additionally rejects zero and anything exceeding Postgres `BIGINT`'s
ceiling. See `docs/accounts-receivable.md#money-representation` for the
full rationale.

## Customer matching for invoice import

The `Customer` model has no stable external business identifier (no
"customer code" field). Per this phase's explicit instruction not to
redesign customer identity, invoice import matches customers by
**normalized email** (trimmed, lowercased) — the same normalization
`customerInputSchema` already applies to a manually-entered email. This is
also why customer CSV import requires an `email` column
(`CUSTOMER_CSV_REQUIRED_HEADERS` in `src/server/ingestion/csv/customers.ts`)
even though `Customer.email` is optional in the general AR domain and
manual customer creation is unaffected: a row with no email would have
no identity for a later invoice import — or a later re-import of the same
customer file — to match against, silently producing duplicate customers.
A row with a missing or invalid email fails outright instead.

**Documented limitation:** `Customer.email` has no uniqueness constraint
at the database level. If two customers in the same organization
genuinely share an email, an invoice CSV row referencing that email
cannot be resolved — it's reported as a row-level failure ("multiple
customers share this email") rather than guessed at. This is judged
acceptable for v1: a real business's customer list rarely has two
distinct customers sharing one email address, and guessing wrong on a
financial record is worse than asking the user to fix the ambiguity by
disambiguating in PAYNORA first.

## Duplicate and conflict semantics

**Customers:** email is a required column for CSV import (see below) —
a normalized-email match, either an existing database row or an earlier
row in the same file, is always **skipped**, never updates the existing
customer. A row with a missing or invalid email **fails** outright,
rather than being created with no way to recognize it on a later
re-import.

**Invoices:** an existing `(organizationId, number)` — in the database or
earlier in the same file — is:
- **skipped** if every imported field (customer, currency, amount, issue
  date, due date) matches exactly. This makes re-importing the exact same
  file a safe no-op.
- **failed**, with an explicit conflict message, if any field differs.
  Existing invoices are never silently overwritten by an import — that's
  the one behavior this module treats as non-negotiable for a financial
  record.

A genuine race (two imports creating the same invoice number
concurrently) is still caught safely: the bulk pre-check can't see a
write that lands between the check and the actual `createInvoice` call,
but `createInvoice`'s own `(organizationId, number)` unique constraint and
`DuplicateInvoiceNumberError` handling catch it regardless — reported the
same way as a pre-existing conflict.

## Atomicity

Structural problems (missing required headers, an empty file, more rows
than the limit) reject the **whole file** before any database write
happens — see `MAX_IMPORT_ROWS` in `src/server/ingestion/limits.ts`. A
malformed *individual* row (wrong field count, an unterminated quote)
does **not** reject the file — it's reported as a row-level failure like
any other invalid row, and every other row in the file is still
processed normally.

Within a file that passes structural validation, every row gets an
explicit, deterministic outcome — `created`, `skipped`, or `failed` — and
each row's write (when it happens) reuses `createCustomer`/`createInvoice`'s
own existing transaction. There is no "some rows were silently never
looked at" case: the returned `ImportSummary.rows` array always has
exactly one entry per input row.

## Limits

- `MAX_IMPORT_ROWS = 2000` (`src/server/ingestion/limits.ts`) — enforced
  before any row is parsed into a record. Not configurable per phase's
  "no background-job system" constraint — a larger import is a
  background-job problem this phase deliberately does not solve.
- `MAX_IMPORT_FILE_SIZE_BYTES = 5 MB` — enforced on the uploaded `File`
  object before its content is even read into memory
  (`src/app/app/[orgSlug]/import/actions.ts`).
- Both bulk lookups (existing customers by email, existing invoices by
  number) are single `IN (...)` queries scoped to the ids that actually
  appear in the file — not the whole organization's table, and not one
  query per row.

## File handling

Uploaded CSV content is read into memory for the duration of one request
and never persisted to disk or the database — there is no "import batch"
history table in this phase. Nothing about the uploaded file's content
(customer names, emails, financial figures) is ever logged. A file is
rejected up front if it doesn't look like a `.csv` (extension or
`Content-Type`) or exceeds the size limit, before any of its content is
parsed.

## UI

`/app/[orgSlug]/import` — a dedicated page (not a sidebar nav item, to
avoid touching the fixed 6-item primary navigation for a Phase 10.2
feature) reachable via an "Import" button next to "New customer"/
"New invoice" on the respective list pages. Two tabs (Customers/Invoices,
`?type=` query param, same link-driven `Tabs` pattern used elsewhere),
each showing the exact expected headers, a plain `<input type="file">`
(no drag-and-drop library — the brief's own guidance not to add one
without genuine need), and a post-import summary: exact created/skipped/
failed counts plus a per-row detail table (capped at 500 displayed rows
for very large files; the counts above the table are always exact for
the whole file regardless of the display cap).
