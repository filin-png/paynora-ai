# PAYNORA — Project Audit V1 (Post-Phase-8 Full Adversarial Audit)

**Baseline commit:** `ddcd7d318031f592805a75bdbe23a3a54ca9aefa` (merge of PR #9,
Phase 8 — Production Communications & AI). 416 tests passing, all CI gates
green at the time of this audit.

**Status of this document:** historical record. This is the audit as it
stood before Phase 9 (Production Hardening) closed the findings below —
it is preserved as-is and is **not** rewritten to pretend the problems
never existed. See `PAYNORA-AUDIT-V1-REMEDIATION.md` for what happened to
each finding.

This audit was conducted as a dedicated adversarial pass across the
entire codebase — security, architecture, financial correctness, and
commercial readiness — independent of and after the Phase 1–8 feature
work. It made no code, schema, or documentation changes; it only produced
findings.

## Executive verdict

PAYNORA at the Phase 8 baseline is a well-architected, thoroughly
tenant-isolated, thoroughly-tested single-tenant-safe application with a
real (if intentionally minimal) AI/Email/Telegram integration surface.
It is **not** production-ready for real customer traffic as it stood:
several gaps are the kind that only surface under real concurrency, real
scale, or real abuse — exactly the things a single-developer feature-by-
feature build is structurally prone to missing, because each phase's own
test suite exercises that phase in isolation, not the whole system under
adversarial load. None of the findings below are architectural rewrites;
all are closable without touching the product's shape.

## Baseline

- 416 automated tests passing, all against a real Postgres test database
  (no mocked DB layer).
- Full tenant isolation coverage for every Phase 1–5 resource.
- No P0 findings from the Phase 6/7/8 audits carried forward unaddressed
  — this audit is the first pass looking specifically at production
  operability rather than feature correctness.

## P0 findings (must fix before any real user traffic)

**P0-1 — No rate limiting on authentication.** `authorize()` (NextAuth
credentials callback, `src/server/auth/config.ts` at the time) had no
rate limiting of any kind — neither per-IP nor per-account. Sign-in was
open to unlimited brute-force and, via the distinguishable "wrong
password" vs. "no such account" behavior implied by typical credential
flows, account enumeration. No infrastructure existed to bound this (no
counter table, no middleware).

## P1 findings (must fix before calling this a beta candidate)

- **P1-1 — Payment recording has no idempotency key.** `recordPayment`
  accepted a raw amount with only the existing row lock protecting
  against overpayment; a network retry or a double-click during a slow
  request could record the same payment twice, with no client-side or
  server-side deduplication mechanism at all.
- **P1-2 — AI-drafted reminder content is validated only for shape, never
  for truth.** The AI safety story stopped at Zod schema validation
  (subject/body are strings). Nothing checked that the AI's output
  actually contained the real invoice number or the real outstanding
  amount, or that it didn't invent a different amount, a different due
  date, or a bank-account-shaped string that isn't in the deterministic
  source facts at all.
- **P1-3 — A `Communication` stuck at `SENDING` has no recovery path.**
  Every `allowedFrom` list in `sendCommunication` excluded `SENDING`
  permanently — a process crash between claiming a send and recording its
  outcome left the row stuck forever, and the Action Center's own
  "Resend anyway" button was reachable from that state and guaranteed to
  fail.
- **P1-4 — No automation observability.** `runAutomationTick` had no
  heartbeat, no persisted run history, and no way for an external
  monitor to distinguish "the process is up" from "automation last ran
  successfully N minutes ago" versus "automation has been silently
  broken for a week."
- **P1-5 — The automation tick has no bound on per-invocation work.**
  `runAutomationTick` iterated every organization with automation enabled
  in one pass, with no batching, no cursor, and no isolation between one
  organization's unhandled exception and every other organization's
  processing for that tick.
- **P1-6 — Several core list queries have no upper bound.** The
  invoices list, customers list, and both invoice/customer activity
  timelines fetched every matching row unconditionally — fine at
  current data volumes, a real risk at real transaction volume.
- **P1-7 — No abuse/cost controls on AI generation, sends, or operator
  runs.** `aiGenerationPolicy`/`communicationSendPolicy`/
  `operatorRunPolicy`-shaped protections did not exist at all; nothing
  bounded how much real AI-provider spend or real email/Telegram send
  volume one organization (or an attacker with access to one account)
  could generate.
- **P1-8 — No decided production deployment/DB-connection model.**
  `DEPLOYMENT.md` explicitly deferred the hosting decision to "the phase
  that actually needs a public deployment," while the existing
  `src/server/db/client.ts` already implicitly assumed a long-lived
  Node.js process (a module-level singleton `PrismaClient`) — a real gap
  between what was written down and what the code actually required.

## P2 findings (hardening, not launch-blocking)

- Sign-up returns a specific "an account with this email already exists"
  error with no rate limiting on the sign-up endpoint — an
  email-enumeration vector.
- The AI communication safety work covered the AI-generation path but a
  parallel CRLF-injection gap existed for it specifically (the
  human-edit path already had this check).
- `computeInvoiceFinancials` computed `outstandingMinor` with no
  defense-in-depth against an upstream invariant violation (relying
  entirely on `recordPayment`'s overpayment check, with no backstop if
  that were ever bypassed).
- No documented DB-level invariant existed preventing more than one
  default `CollectionPolicy` per organization — enforced only in
  application code (`setDefaultCollectionPolicy`).
- Every business table's `organizationId` foreign key is
  `onDelete: Cascade`, with no documentation anywhere of the blast radius
  of an organization deletion (theoretical today — no product code path
  triggers it — but undocumented).
- Several secondary lists (`listPaymentsForInvoice`,
  `listPendingActionProposals`, `listActiveCollectionSequences`) had no
  defensive bound, lower risk than the P1-6 lists but still unbounded.
- No backup/point-in-time-recovery story was written down anywhere in
  the repository.
- `ARCHITECTURE.md` had drifted: it still claimed `MessagingProvider` had
  "no domain call site yet," which became false as of Phase 8.
- The `(no-org)` route group (`/app`, `/app/organizations/new`) was
  missing a `loading.tsx`, unlike every other route group in the app.
- No confirmation step existed before enabling `AUTO_SEND` on a policy,
  before enabling the organization-level automation kill-switch, or
  before a first manual send — all one click, no "are you sure" for
  actions that dispatch real customer-facing communication or turn on
  unattended sending.

## P3 / noted, not required

Out of scope for this audit's remediation mandate and explicitly not
pursued in Phase 9: billing/Stripe integration, new product modules,
landing/branding changes, a provider-architecture rewrite, an inbound
Telegram bot, banking integrations, or any weakening of existing security
checks to make a finding "go away" instead of closing it.

## Readiness scorecard (at this baseline)

| Area | Rating |
|---|---|
| Tenant isolation | Strong — no findings |
| Financial correctness (core AR) | Strong — no findings |
| Auth security | Weak — P0-1 |
| Send/AI abuse resistance | Weak — P1-2, P1-7 |
| Operational resilience (crash recovery, observability) | Weak — P1-3, P1-4, P1-5 |
| Scale readiness | Weak — P1-6, P1-8 |
| Documentation accuracy | Fair — several drifted claims |
| UX safety for high-risk actions | Weak — no confirmation step anywhere |

## Commercial reality

None of the above blocks a genuine private beta with a small, trusted
set of organizations under close supervision. All of it blocks an
unsupervised public launch, and several items (P0-1 especially) would be
actively dangerous to skip even for a beta with real customer emails and
payment records in it.

## Recommended remediation order

1. P0-1 (auth rate limiting) — the only finding with a real, immediate
   exploit path.
2. P1-3 (SENDING recovery) and P1-1 (payment idempotency) — both are
   "a crash or a double-click corrupts real financial/communication
   state" classes of bug.
3. P1-2 (AI safety) — the AI path is the one place free-text content
   reaches a real customer inbox.
4. P1-4/P1-5 (observability + batching) — architecturally intertwined,
   do together.
5. P1-6, P1-7, P1-8 — scale/cost/deployment, real but not urgent at
   current traffic.
6. P2 batch — hardening, opportunistic.

## Final go/no-go

**No-go for unsupervised public launch. Go for a closely-supervised
private beta only after P0-1 and P1-3 close at minimum** — those two are
the findings with a plausible near-term real-world trigger even at low
traffic (a slow network request, a process restart under any commodity
hosting).

See `PAYNORA-AUDIT-V1-REMEDIATION.md` for what actually happened to every
finding above.
