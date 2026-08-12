# PAYNORA — Audit V1 Remediation (Phase 9: Production Hardening & Beta Readiness)

Maps every finding in `PAYNORA-AUDIT-V1.md` to what was actually done
about it. Branch: `claude/phase-9-production-hardening`, based on the
audit's baseline commit `ddcd7d3`. Not merged as of this document —
see the PR for current CI status before treating anything here as final.

**Honest framing, stated once here instead of repeated per finding:**
closing these findings makes PAYNORA a **beta candidate**, not a
launched product. No billing, no Stripe, no new product surface, and no
claim of "production-ready" beyond what's explicitly stated per finding
below.

## P0

### P0-1 — No rate limiting on authentication

**Status:** Closed.

**Implementation:** New Postgres-backed fixed-window rate limiter
(`src/server/rate-limit/`) — deliberately not in-memory, since an
in-process counter is meaningless the moment more than one server
process exists. Applied per-IP (`AUTH_IP_POLICY`, 30/15min) and
per-account (`AUTH_ACCOUNT_POLICY`, 10/15min, reset on successful login)
on credential sign-in. A rate-limited attempt returns the exact same
generic failure as a wrong password — no enumeration signal. An
unexpected error in the check fails **closed** (blocks the attempt)
rather than silently allowing it through — a deliberate, documented
choice given this is a security control. `authorize()`'s logic was
extracted into a standalone `authenticateCredentials()`
(`src/server/auth/authenticate.ts`) specifically so this is directly
unit-testable without the NextAuth stack.

**Tests:** `src/server/rate-limit/service.test.ts` (9 tests, including a
real-concurrency test proving N concurrent callers can't race past the
limit), `src/server/auth/authenticate.test.ts` (10 tests: IP limit,
account limit, reset-on-success, enumeration-safety, fail-closed
behavior).

**Limitation:** fixed-window counting allows up to ~2x `maxAttempts` in a
worst-case boundary-straddling burst — an accepted, documented trade-off
for an abuse backstop, not a precision billing meter.

---

## P1

### P1-1 — Payment recording has no idempotency key

**Status:** Closed.

**Implementation:** `Payment.idempotencyKey` (nullable `String`,
`@@unique([invoiceId, idempotencyKey])` at the DB level). Client (the
payment form) generates and manages the key's lifecycle; `recordPayment`
locks the invoice row (existing pattern), checks for an existing payment
with the same key, and falls back to a `P2002` catch if a race loses to
a concurrent identical request — returns the original payment instead of
creating a duplicate.

**Tests:** `src/server/ar/payments.test.ts` — 9 new tests covering
same-key idempotent retry, different-key genuine second payment,
concurrent identical-key requests (real concurrency, not mocked).

**Limitation:** none identified — this closes the finding as stated.

### P1-2 — AI-drafted content validated only for shape

**Status:** Closed.

**Implementation:** `checkGeneratedReminderSafety`
(`src/server/communications/ai-safety.ts`) — deterministic (not a second
AI call) post-generation check: the real invoice number and outstanding
amount must appear verbatim; no other currency-shaped amount or
contradicting ISO date may appear; no bank-account/IBAN-shaped token may
appear; subject/body must contain no CR/LF or other control characters
(closes the parallel P2 CRLF gap in the same change). A failed check
degrades to the existing deterministic template — never blocks preparing
a reminder.

**Tests:** `src/server/communications/ai-safety.test.ts` (14 tests),
`draft.test.ts`'s new fallback describe block (4 tests: malicious
content rejected + falls back, rejection reason recorded without leaking
the rejected content, safe content accepted unchanged, malformed output
still falls back).

**Limitation:** deliberately does not attempt full natural-language date
parsing ("mid-January" isn't caught, only ISO-shaped dates) — documented
in the code as an accepted, bounded scope rather than an attempt at a
too-fragile general check.

### P1-3 — `SENDING` has no recovery path

**Status:** Closed.

**Implementation:** `reconcileStaleSendingCommunication`
(`src/server/communications/send.ts`) — a deliberately two-step recovery.
Once a `SENDING` communication's most recent `PENDING` `DeliveryAttempt`
has sat unresolved past `STALE_SENDING_THRESHOLD_MS` (10 minutes,
comfortably past the ~15s real provider timeout), an explicit, auditable
action moves it to the already-well-understood `UNCERTAIN` state — it
never resends by itself; actually resending still requires the existing
`acknowledgeUncertainRisk` step. Concurrency-safe via the same
compare-and-swap pattern used throughout the codebase. The UI now
distinguishes a fresh `SENDING` (informational only) from a stale one
(offers the reconcile action).

**Tests:** 7 tests in `send.test.ts` (fresh-cannot-reconcile,
stale-reconciles, never-auto-resends, concurrent-reconcile-only-one-wins,
tenant isolation, correct-attempt-updated, cross-org rejection). Verified
end-to-end in a real browser (seeded a genuinely stuck `SENDING` row,
confirmed the recovery button, the state transition, and that "Resend
anyway" still requires its own confirmation).

**Bonus finding closed during this phase's own adversarial self-review:**
`finalizeSuccess`/`finalizeTerminal` wrote the dispatch outcome
unconditionally by id, unlike the claim step (which already used a
compare-and-swap). A provider call that outlives its own gateway timeout
could still be in flight when reconcile independently resolves the same
attempt — whichever write landed last would silently win, contradicting
this module's own documented guarantee. Fixed by gating both finalize
functions on the attempt still being `PENDING`, exactly mirroring the
claim step. 2 new regression tests simulate a late-arriving success and a
late-arriving definite failure after the same attempt was already
reconciled, asserting the reconciled state survives untouched.

**Limitation:** the underlying "no outbox/reconciler" limitation
documented since Phase 4 still applies if step 3 of `sendCommunication`
itself fails to commit after a successful provider call — that residual
gap is unchanged by this phase and remains a known, accepted limitation
of a single-process app without a message-outbox pattern.

### P1-4 — No automation observability

**Status:** Closed.

**Implementation:** New `AutomationTickRun` heartbeat table — every tick
persists its outcome (success/crash, counts, duration). New
`GET /internal/automation/health` endpoint, same bearer-secret auth as
the existing tick endpoint, distinguishing `live` (process responds) from
`ready` (a recent, non-crashed tick occurred). Never exposes customer,
invoice, or organization identifiers — only counts and timestamps.

**Tests:** `src/server/collections/health.test.ts` (11 tests),
`src/app/internal/automation/health/route.test.ts` (7 tests, including
an explicit assertion the response body never contains customer/org
names).

**Limitation:** stated explicitly in the endpoint's own design and in
DEPLOYMENT.md — this is a machine-readable signal an external monitor
can poll, not a real alerting/monitoring setup; wiring it to something
that actually pages a human needs that tool's own credentials, which is
outside what this repository can commit to on its own.

### P1-5 — Automation tick has no bound on per-invocation work

**Status:** Closed.

**Implementation:** `runAutomationTick` now processes organizations in
bounded batches via a persisted cursor
(`Organization.automationLastTickAt`, `ORDER BY ASC NULLS FIRST` + id
tiebreak) instead of scanning every organization per invocation.
Per-organization exception isolation added above the pre-existing
per-sequence isolation, with a `finally` block guaranteeing cursor
bookkeeping always advances regardless of success/failure — one org's
crash can't skip or block the rest of the batch.

**Tests:** `engine.test.ts` — "bounded batching" (6 tests) and
"tick-run telemetry persistence" (3 tests) describe blocks.

**Limitation:** a genuinely unhandled exception inside per-org processing
(as opposed to a gracefully-handled bad-state scenario) is verified by
code review, not by a test that forces one — constructing that scenario
in this test suite's black-box style would require deliberately
corrupting referential integrity, which was judged not worth the
resulting weak/misleading test. Documented in the test file itself.

### P1-6 — Core list queries have no upper bound

**Status:** Closed for the four lists named in the audit (invoices,
customers, invoice activity, customer activity).

**Implementation:** Opt-in cursor/`take` pagination added to
`listInvoicesWithFinancials`, `listCustomers`, `listInvoiceActivity`,
`listCustomerActivity` — deliberately opt-in, not a lowered default,
because the collections automation engine, sequence enrollment, and
overdue-event detection all call `listInvoicesWithFinancials` expecting
every open/overdue invoice for the organization; capping it by default
would have silently truncated automation. Only the UI list pages pass
`take`/`cursor`. `listCustomers` (no backend batch consumer) does get a
generous default cap (100) for callers that don't paginate at all (the
invoice-form customer picker). Each list page uses a "peek ahead"
(`take N+1`) to show a "Next page" link without a separate `COUNT` query.

**Tests:** pagination-boundary tests in `invoices.test.ts`,
`customers.test.ts`, `activity.test.ts` (exact-page-size and
exact-remainder cases), plus explicit cross-organization cursor tests
added during this phase's own adversarial self-review (a cursor id
belonging to another organization's row can never leak that
organization's data — not exploitable given the where-clause structure,
but locked in as regression coverage rather than left implicit).
Verified live in a browser with 55+ seeded records per list.

**Limitation:** because invoice `filter` (open/overdue/paid) is evaluated
in-memory against computed financials rather than a stored column, a
filtered page may return fewer than the page size — documented as an
accepted trade-off, not a bug. Several *secondary* lists
(`listPaymentsForInvoice`, `listPendingActionProposals`,
`listActiveCollectionSequences`) got a defensive cap only (P2-3 below),
not full pagination — they're naturally self-limiting and didn't
warrant the same UI investment.

### P1-7 — No abuse/cost controls on AI/send/operator-run

**Status:** Closed.

**Implementation:** `aiGenerationPolicy`/`communicationSendPolicy`/
`operatorRunPolicy` (env-configurable, hourly, org-scoped) wired into
their real call sites. AI generation: a rate-limited check degrades to
the deterministic template exactly like a disabled/unreachable AI
provider already did — never blocks preparing a reminder. Communication
send: checked before any state change, alongside provider resolution, so
a blocked send never creates a `DeliveryAttempt`; applies uniformly to
`USER` and `AUTOMATION` sends (the point is a total org cost ceiling
regardless of trigger). Operator run: refused outright before any
detection/insight/proposal work.

**Tests:** integration tests in `draft.test.ts`, `send.test.ts`,
`pipeline.test.ts` covering exhaustion behavior and per-organization
isolation for all three.

**Limitation (documented in the code itself):** the communication-send
check is placed *before* the atomic claim step, so two truly concurrent
duplicate requests (a double-click) can each consume a rate-limit slot
even though only one ever dispatches — an accepted, narrow imprecision
(at most one wasted slot per genuine race) rather than inventing a new
terminal `DeliveryAttempt` outcome for "claimed but blocked before
dispatch."

### P1-8 — No decided production deployment/DB-connection model

**Status:** Closed.

**Implementation:** Decided: a long-lived Node.js process (`next start`
or an equivalent container), not an edge/serverless-per-invocation model
— because the existing DB layer already assumed exactly that (one
`PrismaClient`/`pg.Pool` per process, reused for its lifetime).
`DATABASE_POOL_MAX` (already defined in `env.ts`, previously unused) is
now wired into the `PrismaPg` adapter's pool config.
`DEPLOYMENT.md`'s "Hosting (future)" section is replaced with a decided
"Production hosting model" section covering runtime, deploy target,
migrations (`prisma migrate deploy` as a deploy-time step, never at
request time), scheduler, and health/readiness — explicit about what's
still left to whoever operates the deployment (TLS, orchestration,
secrets, CDN).

**Tests:** not independently unit-tested (a connection-pool config
value) — validated by the entire existing test suite continuing to pass
against the reconfigured client, and by `npm run build` succeeding.

**Limitation:** this is a decision and its documentation, not a live
deployment — no real hosting target has actually been stood up against
this document yet.

---

## P2 (quick hardening batch)

| Finding | Status | Notes |
|---|---|---|
| P2-1 sign-up enumeration | Partially closed | `SIGNUP_IP_POLICY` (10/hour) bounds mass enumeration attempts from one source; the response message itself still confirms account existence per attempt within that budget — full enumeration-safety would require deferring auto-sign-in behind email verification, judged out of scope for a "quick hardening" item and not pursued without an explicit product decision. |
| P2 AI-path CRLF | Closed | Folded into P1-2 — `checkGeneratedReminderSafety` checks CR/LF in the AI-generation path, closing the gap the human-edit path already covered. |
| P2-2 financial invariant defense-in-depth | Closed | `computeInvoiceFinancials` now clamps `outstandingMinor` to zero and logs loudly if `paidMinor` ever exceeds `amountMinor` — behind `recordPayment`'s existing `OverpaymentError`, not a replacement for it. 2 tests (`invoices.test.ts`). |
| P2 default-policy DB invariant | Closed | Partial unique index `collection_policies_one_default_per_org` (`WHERE "isDefault" = true`) added in the Phase 9 migration — a real DB-level backstop on top of the existing application-level `setDefaultCollectionPolicy` enforcement. |
| P2 org-delete-cascade docs | Closed | Documented in `SECURITY.md` — every business table's `organizationId` FK is `onDelete: Cascade`; no product UI path exists to trigger it, but the blast radius is now written down for anyone with direct DB access or building a future delete feature. |
| P2-3 remaining pagination | Closed (defensive caps, not full pagination) | `listPaymentsForInvoice`, `listPendingActionProposals`, `listActiveCollectionSequences` got a defensive `take` cap (500/500/500) — naturally self-limiting lists, judged not to need a pagination UI. `listActiveCollectionSequences`'s only UI caller was capped; explicitly documented that the automation engine itself must never call the capped version. |
| P2 backup/PITR docs | Closed | New "Backups & point-in-time recovery" section in `DEPLOYMENT.md` — application code has no undo for tenant-data deletion, so this is an operational requirement for whoever runs the database, not something code can substitute for. |
| P2 automation confirmation | Closed | Folded into the P1/P2 confirmation-UX work below. |
| P2 stale ARCHITECTURE.md | Closed | Fixed the false "`MessagingProvider` has no domain call site yet" claim (true as of Phase 8); added the Phase 9 additions (`rate-limit/`, the health endpoint, `RateLimitCounter`/`AutomationTickRun`) that were missing from the layout tree and schema list. |
| P2 missing loading state | Closed | Added `src/app/app/(no-org)/loading.tsx` — every other route group already had one. |

---

## P1/P2 — High-risk confirmation UX

**Status:** Closed.

**Implementation:** New reusable `ConfirmActionButton`
(`src/components/ui/confirm-action-button.tsx`), built on the existing
`Dialog` component (native `<dialog>`, focus trap and Escape-to-close for
free) — applied only to the handful of actions that are genuinely hard to
undo: enabling `AUTO_SEND` on a policy, enabling the organization
automation kill-switch, and the first manual send of a reminder. The
*safe* direction of each toggle (disabling) stays a single click — not a
flood of modals on every button.

**Tests/verification:** end-to-end browser verification of all three
confirm flows (dialog title/description correctness, Escape/Cancel,
keyboard-Enter activation on the trigger, `aria-labelledby` wiring, and
that the safe direction never shows a dialog).

**Limitation:** no automated `axe`-style accessibility scan was run;
verification was manual (keyboard activation, focus, ARIA attribute
presence) against the existing `Dialog` primitive, which is already used
elsewhere in the app.

---

## Full validation gate (final state)

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm run db:validate` — schema valid.
- `npm run test` — 517 tests passing (up from 416 at the audit baseline;
  101 new tests added across P0/P1/P2 work plus this phase's own
  adversarial-self-review fix).
- `npm run build` — production build succeeds, including the two new
  routes (`/internal/automation/health`).
- Tenant-boundary review of every changed Server Action and pagination
  path — no findings (see the confirmed-clean review, including the
  added cross-org cursor regression tests).
- Adversarial self-review of this phase's own new code — one genuine
  race condition found and fixed (see P1-3 above); no other findings.
- Secret scan of the full diff against the audit baseline — no hardcoded
  credentials found.
- Responsive QA at 390/768/1024/1440px on the changed pages — no
  horizontal overflow at any width.

## What this phase explicitly did not do

Per the phase's own mandate: no billing/Stripe work, no new product
modules, no landing/branding changes, no provider-architecture rewrite,
no inbound Telegram bot, no banking integrations, no weakening of any
existing security check to make a test pass, no deleting a good test, no
replacing a concurrency test with a mock, and no self-merge — this
branch is opened as a PR and left for the account owner to merge.
