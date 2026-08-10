# Security

PAYNORA handles financial data (invoices, payments, customer collection
communication) for multiple tenants. Security is a baseline requirement,
not a later add-on.

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
  Automated tests cover this once multi-tenant data access exists
  (Phase 1).
- **Secrets never enter source control.** `.env*` files are gitignored
  except `.env.example`, which documents variable names only — no real
  values. See `.env.example` for the current (empty) list.
- **Prompt-injection awareness.** Customer email/message content fed into
  AI features is untrusted input. Before any AI feature consumes external
  communication (Phase 3+), its prompt construction is reviewed for
  injection risk and its output is schema-validated before use.
- **Idempotency for money-adjacent automation.** Background jobs and
  webhook handlers (Phase 4+) are designed to be safely retried — running a
  reminder job twice must not send a duplicate reminder.
- **No sensitive data in logs.** Structured logging (introduced when
  observability infrastructure is added) excludes credentials, tokens, and
  full customer payment details.

## Current status (Phase 0)

There is no user data, authentication, or multi-tenant data access in the
codebase yet, so most of the above principles apply to *how future work
must be built* rather than something to audit today. The concrete
Phase 0 security posture is:

- No secrets are committed. `.env.example` documents variable names only.
- Dependencies are installed from the public npm registry with no known
  vulnerabilities at time of writing (`npm audit` reports 0 vulnerabilities
  as of the last dependency install).
- CI runs typecheck and lint on every change, catching an entire class of
  correctness issues before they reach `main`.

## Reporting a vulnerability

This repository does not yet have a public release or paying customers.
Until a dedicated security contact is published here, report concerns by
opening a GitHub issue marked `security` with minimal public detail, or by
contacting the repository owner directly.
