# Wallet Foundation & Crypto Payments (Phase 13)

This document describes what Phase 13 actually built: a real, tested,
production-shaped domain architecture for connecting crypto wallets and
reconciling on-chain payments against PAYNORA invoices — and, just as
importantly, what it deliberately does **not** do yet. Nothing here claims
a real wallet provider, a real blockchain connection, or a real customer
transaction is live. `WALLET_PROVIDER` defaults to `none`; every wallet,
transaction, and reconciliation shown anywhere in the product is real
data produced by the domain functions below, never a fabricated demo.

## 1. Wallet domain

`src/server/wallet/wallets.ts` owns the `Wallet` model's lifecycle:

- `connectWallet(organizationId, {network, address, label?}, provider)` —
  registers an address as `PENDING_VERIFICATION`. The address is a public
  identifier the caller supplies; nothing about connecting asks for or
  stores a credential.
- `verifyWalletOwnership(organizationId, walletId, proof, provider)` —
  the only path from `PENDING_VERIFICATION` to `ACTIVE`, gated on
  `provider.verifyOwnership` actually succeeding. A failed proof is a
  normal, recoverable outcome (no error, wallet stays
  `PENDING_VERIFICATION`).
- `disconnectWallet(organizationId, walletId)` — `ACTIVE`/
  `PENDING_VERIFICATION` → `DISCONNECTED`, terminal. A "reconnected"
  wallet is a new row, not a resurrected one, so the audit trail of who
  was connected when is never overwritten.
- `getWallet` / `listWallets` — tenant-scoped reads.

A wallet supports multiple blockchain networks and multiple providers
because `network` and `providerName` are plain, allowlisted strings
(`src/server/wallet/network.ts`), not a fixed schema enum — recognizing a
new chain or vendor is a one-line allowlist change, never a migration
(same discipline as `Currency`, `src/server/ar/currency.ts`).

## 2. Ownership

A `Wallet` belongs to exactly one `Organization` — the safest model the
existing tenancy architecture supports, matching every other AR/financial
model (`Invoice`, `Payment`, ...). There is no per-user wallet ownership in
this phase: connecting, verifying, and disconnecting a wallet are
organization-level actions, authorized the same way every other
org-scoped write is (`requireOrganizationMembershipForPage`/
`requireOrganizationRoleForPage` at the Server Action boundary — domain
functions themselves take an already-authorized `organizationId`, exactly
like `updateOrganizationName`, `recordPayment`, etc.).

`Wallet.@@unique([network, address])` is **global**, not
organization-scoped — the one deliberate exception to this codebase's
usual per-tenant uniqueness convention. A real on-chain address is one
external fact that cannot legitimately belong to two different PAYNORA
organizations at once; making the constraint global is what makes
cross-tenant transaction misattribution structurally impossible (see
[§18 Tenant isolation](#tenant-isolation) below) rather than merely tested
against.

## 3. Provider abstraction

```
Domain code (wallets.ts, transactions.ts, reconciliation.ts)
        |
   WalletProvider interface   (src/server/wallet/provider-types.ts)
        |
   resolveWalletProvider()    (src/server/wallet/service.ts)
        |
   noneWalletProvider | (future) CoinbaseWalletProvider | PrivyWalletProvider
```

`WalletProvider` is deliberately narrow, mirroring `BillingProvider`
(`src/server/billing/types.ts`): it observes and reports, it never itself
decides PAYNORA financial state. Its methods: `connectWallet`,
`verifyOwnership`, `getBalances`, `inspectTransaction`,
`verifyAndParseWebhookEvent`. "Create payment request" from the phase
brief's capability list is **not** a provider method — a
`CryptoPaymentRequest` is a PAYNORA-domain concept tied to one invoice; a
wallet provider has no notion of a PAYNORA invoice at all, so that
capability lives entirely in `src/server/wallet/payment-requests.ts`.

`resolveWalletProvider()` (`src/server/wallet/service.ts`) is the one
place that knows real vendor names exist. `WALLET_PROVIDER=none` (the
default) resolves to `noneWalletProvider`, which throws
`WalletDisabledError` on every call — domain code never has to
null-check. `coinbase`/`privy` are recognized-but-unimplemented, resolving
to a clear `WalletProviderNotImplementedError` — the same precedent as
`AI_PROVIDER`'s `gigachat`/`yandex` and `BILLING_PROVIDER`'s
`stripe`/`yookassa`. The provider registry
(`src/server/providers/registry.ts`) reports `wallet` as a fifth category
alongside `ai`/`email`/`messaging`/`billing`, surfaced honestly in
Settings → Integrations.

`src/server/wallet/providers/fake.ts` (`createTestWalletProvider`) is the
test-only adapter — never selectable via `WALLET_PROVIDER`, only ever
reachable by a test importing it directly. Its webhook signing is a real
HMAC-SHA256 over the raw body (not a bypass), so tests genuinely exercise
signature failure, malformed payloads, and replay rather than only ever
taking a hard-coded success path.

## 4. Security model

- **No private keys, no seed phrases, no signing secrets in Prisma.**
  `Wallet` stores an `address` (a public identifier) and an optional
  `providerWalletId` (an opaque connection reference) — nothing else. Grep
  the schema: there is no `privateKey`, `seedPhrase`, `mnemonic`, or
  signing-credential column anywhere in the Wallet Foundation section of
  `prisma/schema.prisma`, and `wallets.test.ts` asserts this directly.
- **No wallet secrets in logs or ActivityEvent metadata.** Every
  `recordActivityEvent` call in the wallet domain passes only ids,
  networks, asset symbols, and amounts — never a signature, private key,
  or raw webhook body/header. `WalletWebhookVerificationError`'s own
  message never includes the signature or body it rejected (same
  discipline as `BillingWebhookVerificationError`).
- **Organization-level ownership, authorization before access.** Every
  wallet-domain function takes `organizationId` as its first parameter and
  threads it through every query; role-gating (e.g. OWNER-only wallet
  connect/disconnect, mirroring `renameOrganizationAction`'s
  `requireOrganizationRoleForPage(orgSlug, "OWNER")` pattern) belongs at
  the Server Action layer that will call these functions from a real
  connect-wallet UI in a future phase.
- **Tenant isolation.** See [§18](#tenant-isolation).
- **Provider credentials.** Not applicable in this phase — no real
  provider is configured, so no API key/credential exists to protect yet.
  When a real adapter is added, its credential belongs in environment
  variables only (`WALLET_WEBHOOK_SECRET` already exists as the shape a
  real deployment's shared HMAC secret would take — see `src/lib/env.ts`),
  never in the database, exactly like every other provider credential in
  this codebase.
- **Wallet addresses are identifiers, not authentication credentials.**
  Nothing in this codebase treats knowing an address as proof of anything
  — ownership is only ever established through
  `verifyWalletOwnership`/`provider.verifyOwnership`.

## 5. Transaction model

`WalletTransaction` (`prisma/schema.prisma`) represents one real on-chain
transaction, independent of any specific provider — the shape every
`RawWalletEvent` a provider adapter emits gets normalized into. Fields:
`txHash`, `network`, `asset`/`assetDecimals`, `amountMinor` (the asset's
own smallest unit — bigint, never a float, same discipline as
`Invoice.amountMinor`), `direction` (`INCOMING`/`OUTGOING`), `status`,
`confirmations`/`requiredConfirmations`, `detectedAt`/`confirmedAt`,
`providerName`/`providerEventId`, `metadata` (safe fields only),
`failureReason`.

**Blockchain Transaction is explicitly not the same thing as PAYNORA
Invoice Payment.** A `WalletTransaction` never itself changes an invoice's
status — only `reconciliation.ts`, after applying real rules, ever creates
a `Payment` row. `reconciledPaymentId` is the one link between the two
models, set only once reconciliation actually succeeds.

## 6. Transaction state machine

```
DETECTED --> CONFIRMING --> CONFIRMED
   |             |
   +--> FAILED   +--> FAILED
   |             |
   +--> EXPIRED  +--> EXPIRED
```

Enforced by `src/server/wallet/transaction-state-machine.ts`
(`assertValidWalletTransactionTransition`). Derived from the actual
requirement, not copied from the brief's example list verbatim:

- No separate `PENDING` state — a webhook-observed event is either still
  awaiting its first confirmation (`DETECTED`) or already has one
  (`CONFIRMING`); an extra intermediate state added nothing real.
- `DETECTED -> CONFIRMED` directly is legal — a provider that only
  notifies PAYNORA once a transaction is already confirmed (never sending
  an intermediate event) is a realistic provider behavior.
- `DETECTED`/`CONFIRMING` both allow a self-loop — a provider may deliver
  several events for the same transaction while it's still below its
  confirmation threshold (increasing `confirmations` each delivery)
  without that being a status *change*.
- `CONFIRMED`, `FAILED`, `EXPIRED` are terminal. This is what makes a
  late/out-of-order webhook delivery arriving after a transaction has
  already reached one of those states safely **ignored** rather than
  silently overwriting an authoritative outcome — see
  `transactions.test.ts`'s "ignores a late/out-of-order delivery" case.

`EXPIRED` is a real, enforced status in the state machine, but this phase
does not wire a scheduler that automatically transitions a stale
`DETECTED`/`CONFIRMING` row into it — see [§13 Known
limitations](#known-limitations).

## 7. Reconciliation

```
Invoice --> CryptoPaymentRequest --> Wallet (destination) --> WalletTransaction
                                                                    |
                                                          reconcileWalletTransaction
                                                                    |
                                                    MATCHED -> Payment -> Invoice balance/status
                                                    REJECTED (reason)  -> nothing changes
```

`CryptoPaymentRequest` (`src/server/wallet/payment-requests.ts`) is the
pre-registered expectation reconciliation matches an incoming transaction
against — a blockchain transaction carries no PAYNORA invoice id, so
without this row nothing could ever be reconciled at all.
`createCryptoPaymentRequest` caps `requestedAmountMinor` (the fiat amount
this request settles) at the invoice's *current* outstanding balance at
creation time, reusing the same overpayment-avoidance discipline
`recordPayment` already enforces, applied one step earlier.

`reconcileWalletTransaction` (`src/server/wallet/reconciliation.ts`) —
idempotent, and the only place a `WalletTransaction` ever produces a
`Payment`:

1. No-op if already reconciled (`reconciliationOutcome` set), if the
   direction is `OUTGOING`, or if the transaction isn't yet `CONFIRMED`
   (an unconfirmed amount is never guessed at).
2. `FAILED` transactions are rejected (`TRANSACTION_FAILED`) immediately.
3. Finds the **oldest OPEN** `CryptoPaymentRequest` for this wallet +
   network + asset (FIFO) — so a wallet shared across several sequential
   invoices always settles them in the order they were requested. None
   found → `NO_OPEN_PAYMENT_REQUEST`.
4. Compares the received amount to `expectedAssetAmountMinor` **in
   asset-native units only** — see [Underpayment](#underpayment) below.
5. Re-reads the invoice's live outstanding balance and status. Already
   fully paid or cancelled → `INVOICE_ALREADY_SETTLED`, nothing applied.
6. Atomically claims the request (`OPEN -> FULFILLED`, a compare-and-swap
   identical to `Communication`'s `SENDING` claim) immediately before
   calling `recordPaymentInTransaction` (see [§9](#idempotency)) with
   `amountMinor = min(request.requestedAmountMinor, liveOutstanding)` —
   never more than what's genuinely owed, even if the request promised
   more. On success: `WalletTransaction.reconciliationOutcome = MATCHED`,
   linked to the new `Payment`.

## 8. Webhook / event pipeline

```
External Provider
      |
Webhook  ->  ingestWalletWebhookEvent(organizationId, rawBody, signature, provider)
      |
provider.verifyAndParseWebhookEvent   (throws on bad signature/shape)
      |
resolve org's Wallet by (network, toAddress)
      |
idempotent create-or-update WalletTransaction, by (network, txHash)
      |
transaction-state-machine validates the transition (stale replay -> ignored)
      |
reconcileWalletTransactionInTransaction  (auto-triggered on reaching CONFIRMED)
      |
Payment / Invoice update
      |
ActivityEvent (WALLET_TRANSACTION_DETECTED / _CONFIRMED / WALLET_PAYMENT_RECONCILED / WALLET_RECONCILIATION_REJECTED)
```

`src/server/wallet/transactions.ts#ingestWalletWebhookEvent` is the single
provider-independent entry point implementing this whole pipeline in one
call, one database transaction. `organizationId` is supplied by the
**caller** — this phase's intended deployment shape is one webhook route
per organization (e.g. `/api/webhooks/wallet/[orgSlug]`, not built in this
phase — see [§12](#production-integration-point)), so the org is already
known from the route before any payload is parsed. This is what lets a
*known* organization's rejected deliveries be recorded as a real,
tenant-scoped `WALLET_WEBHOOK_REJECTED` activity event, not just a server
log line.

No real external provider is connected — `ingestWalletWebhookEvent` is
fully exercised today only through `createTestWalletProvider` in
`transactions.test.ts`, but the pipeline itself is real, not a stub.

## 9. Idempotency

- **`WalletTransaction.@@unique([network, txHash])`** is the core
  guarantee: a repeated webhook delivery for the same on-chain transaction
  always resolves to the same row. Implemented as an explicit
  `findFirst`-then-branch (create if absent, update if present) rather
  than a catch-P2002-then-continue pattern — Postgres aborts a transaction
  the instant any statement inside it errors, so catching a unique-
  constraint violation and then issuing more queries in that *same*
  transaction fails with "current transaction is aborted." This was found
  and fixed during this phase's own test-writing (see
  `transactions.test.ts`'s idempotency tests) before it could ever reach
  a real deployment.
- **Reconciliation is idempotent** by checking `reconciliationOutcome`
  first — a second call for an already-processed transaction is a pure
  no-op, never a second `Payment`.
- **The `Payment` itself is idempotent** via the *existing*
  `Payment.@@unique([invoiceId, idempotencyKey])` constraint —
  reconciliation passes the `WalletTransaction.id` as the idempotency key,
  so even a hypothetical double-reconciliation could never create two
  Payment rows for one transaction; no new idempotency machinery was
  invented for this, the existing AR guarantee was reused directly.
- **Concurrent reconciliation of two different transactions racing for
  the same OPEN request** is safe via the atomic `OPEN -> FULFILLED`
  compare-and-swap in step 6 above — verified by a real concurrent test
  (`Promise.all` of two genuine `reconcileWalletTransaction` calls) in
  `reconciliation.test.ts`, not just argued about.

## 10. Financial invariants (underpayment / overpayment / wrong asset / etc.)

<a id="underpayment"></a>

- **Exact payment** — received asset amount equals
  `expectedAssetAmountMinor` → `MATCHED`, `requestedAmountMinor` fiat
  applied via the existing `recordPayment` machinery.
- **Overpayment** — received asset amount exceeds
  `expectedAssetAmountMinor` → still `MATCHED`; the excess is visible
  (both amounts are stored on the row) but **never** auto-converted into
  extra fiat credit. The fiat `Payment` amount is always capped at what's
  genuinely owed on the invoice.
- **Underpayment** — received asset amount is below
  `expectedAssetAmountMinor` → `REJECTED`/`UNDERPAID`, the request stays
  `OPEN`. **This is the one place this phase deliberately declines to
  invent financial semantics, per the brief's own instruction to stop and
  report an ambiguity rather than guess.** Converting a partial crypto
  amount into a partial fiat `Payment` requires an exchange rate PAYNORA
  does not have authoritatively — the human-entered rate on the request
  was quoted for the *full* expected amount, and token prices move, so
  assuming linearity for an arbitrary partial fraction would be exactly
  the "pseudo-precise financial model" this project's own conventions
  (see the Phase 12 cash-flow forecast) already reject. A human resolves
  it manually via the existing payment form — the same judgment call they
  would already make for a bank wire that arrived short.
- **Wrong token / wrong network / wrong destination** — a
  `CryptoPaymentRequest` match requires wallet id, network, *and* asset to
  agree simultaneously (`§7` step 3); a transaction wrong on any of those
  axes simply fails to find an open request (`NO_OPEN_PAYMENT_REQUEST`) or
  fails to find the wallet at all (`NO_MATCHING_WALLET`, at the webhook
  layer) — no separate rejection reason was needed for each axis.
- **Duplicate transaction** — prevented at *ingestion*
  (`§9`), not at reconciliation; a duplicate can never become a second row
  in the first place, so it can never reach reconciliation as a distinct
  case.
- **Unconfirmed transaction** — never reconciled; see `§7` step 1.
- **Failed transaction** — always rejected with `TRANSACTION_FAILED`,
  never processed.
- **Partial payments (multiple crypto payments against one invoice)** —
  fully supported by reusing the *existing* AR convention (many `Payment`
  rows against one `Invoice`, outstanding computed live) — no new
  accounting semantics were invented. Verified with a real two-payment
  scenario (€400 + €600 via two separate `CryptoPaymentRequest`s) in
  `reconciliation.test.ts`.

## 11. UI behavior

`/app/[orgSlug]/wallet` (overview) and `/app/[orgSlug]/wallet/[walletId]`
(detail) use the existing design system exclusively — no new components,
no new visual language. Both read straight from `listWallets`/
`listWalletTransactions`; in a deployment with `WALLET_PROVIDER=none` (the
default) these are empty, and the overview page shows an explicit
`Alert` explaining that no production wallet provider is connected —
never a fabricated wallet, balance, or transaction. The invoice detail
page's new "Payment methods" section shows "Bank / card" (the existing
payment form, unchanged) alongside "Crypto," which itself either lists the
invoice's real `CryptoPaymentRequest`s or explains — honestly, not
apologetically hidden — that crypto isn't available in this deployment.

## 12. Production provider integration point

```
PAYNORA domain code
        |
   WalletProvider interface        <- stable, shipped Phase 13
        |
   resolveWalletProvider()         <- dispatches on WALLET_PROVIDER
        |
   AlchemyWalletProvider           <- real adapter, added Phase 14
```

**Phase 14 built the real adapter predicted here**:
`createAlchemyWalletProvider` (`src/server/wallet/providers/alchemy.ts`)
implements `WalletProvider` against Alchemy's Enhanced APIs (balances,
transaction lookups), Notify API (address-activity webhooks), and EIP-191
signature recovery (ownership verification) — wired into
`resolveWalletProvider()` when `WALLET_PROVIDER=alchemy`. A real
per-organization webhook route, `POST /api/webhooks/wallet/[orgSlug]`
(`src/app/api/webhooks/wallet/[orgSlug]/route.ts`), now calls
`ingestWalletWebhookEvent`. **No other file in the wallet domain
changed** — `wallets.ts`, `payment-requests.ts`,
`transaction-state-machine.ts`, `transactions.ts`, and
`reconciliation.ts` remained untouched, exactly as this section
predicted. See `docs/production-integrations.md#wallet` for credentials,
webhook configuration, cost, and exactly which networks/vendors remain
unimplemented (`coinbase`, `privy` — still recognized-but-not-built).

## 13. Known limitations

- **No scheduler transitions a stale `DETECTED`/`CONFIRMING` transaction
  to `EXPIRED`.** The state machine supports it and it's directly
  testable, but wiring a cron/scheduler for it is new automation
  infrastructure the brief explicitly didn't ask for this phase — see
  `docs/audits` precedent for how automation infra was scoped previously.
- **A `CryptoPaymentRequest`'s underpayment tolerance is a single-
  transaction concept.** Accumulating several separate underpaid crypto
  transactions toward one request's expected amount is not implemented —
  each transaction is evaluated independently against the request's full
  expected amount.
- **No FX-rate provider.** `expectedAssetAmountMinor` and
  `requestedAmountMinor` on a `CryptoPaymentRequest` are both supplied by
  whoever creates the request; there is no live conversion between fiat
  and crypto anywhere in this phase, by design (see `§10`).
- **No UI to create a `CryptoPaymentRequest` yet.** The domain function
  exists and is fully tested; the invoice detail page can display existing
  requests but does not yet offer a form to create one (creating one
  requires deciding an asset amount, which in turn requires the FX
  question above — left for the phase that adds a real provider/rate
  source).
- **`getBalances`/`inspectTransaction` are defined on the interface but
  have no UI surface yet** — the wallet detail page doesn't call them.
  Both are exercised by the real Alchemy adapter's tests and by
  `npm run smoke -- wallet` (Phase 14), just not yet rendered anywhere.
- **Only `ETHEREUM`/`POLYGON`/`BSC` are supported by the real adapter.**
  `WalletNetwork` also allows values Alchemy's Notify/Enhanced APIs don't
  cover the same way in this adapter (e.g. Bitcoin/Solana/Tron are
  different products) — selecting an unsupported network throws a clear
  error rather than silently no-oping. See
  `docs/production-integrations.md#wallet`.

---

## Future Phase Wallet: architectural plan (documentation only)

Not implemented in this phase — recorded here per the brief's request for
a short forward-looking plan, nothing more. **Update (Phase 14): the
first two bullets below are now real** — see `§12` and
`docs/production-integrations.md#wallet`. The rest remains an accurate
description of what's still ahead.

- **`WalletProvider` abstraction** — already shipped (`§3`); a future
  phase implements one real adapter against it.
- **Embedded non-custodial model** — PAYNORA should never hold private
  keys; a real integration should use a provider (e.g. embedded-wallet
  SDKs) where the end user's device or the provider's own secure enclave
  holds signing authority, and PAYNORA only ever receives verified,
  read-only events — a direct continuation of `§4`'s security model, not
  a departure from it.
- **Provider-independent domain boundary** — already the actual design of
  every file in `src/server/wallet/` today: none of them import a vendor
  SDK or know a vendor's request/response shape.
- **Wallet↔user/org relationship** — this phase ties a `Wallet` to an
  `Organization` only (`§2`). A future phase could add a
  `Wallet.connectedByUserId` audit field if a product need for
  per-user wallet provenance emerges, without changing the ownership
  model itself.
- **Crypto-payment→invoice reconciliation** — already real (`§7`–`§10`);
  a production phase's only job is to feed real `RawWalletEvent`s into the
  exact same `ingestWalletWebhookEvent`/`reconcileWalletTransaction`
  pipeline that already exists and is already tested.
