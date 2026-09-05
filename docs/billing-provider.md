# Billing provider (Phase 20 — real payment collection)

This documents the real `BillingProvider` adapter and checkout flow added
in Phase 20 — PAYNORA's first real payment collection. It extends, and is
meant to be read alongside, `docs/commercial-product-architecture.md`
(the plan catalog, entitlements, and Settings → Billing UI Phase 19 built)
and `docs/provider-strategy.md`#billingprovider (the original,
recognized-but-unimplemented `BillingProvider` contract from Phase 6).

Nothing here replaces or duplicates the existing billing/entitlement
layer: `PlanId`, `OrganizationSubscription`, `SubscriptionPayment`, the
plan catalog (`src/server/billing/plans.ts`), the entitlement layer
(`src/server/billing/entitlements.ts`), and `/api/webhooks/billing` are
all unchanged in shape — Phase 20 plugs a real vendor into that existing
pipeline, and adds exactly one new model
(`BillingCheckoutSession`) that the pipeline was missing.

## Why a new model was needed

Before Phase 20, `applySubscriptionWebhookEvent` only knew how to
apply a *status* change to an already-linked `OrganizationSubscription`
(matched by `externalCustomerId`/`externalSubscriptionId`) — there was no
concept of "this specific payment corresponds to this specific upgrade
request." That's fine for a Stripe-style flow where a subscription object
already exists and a webhook just reports its status. It is not safe for
a one-time-payment flow (see below): without a record of *what a payment
was actually for*, a webhook body's own claims (customer id, price id,
plan id) would be the only source of truth for "who gets upgraded to
what" — and webhook bodies are attacker-observable/replayable data, not
an authorization boundary.

`BillingCheckoutSession` (`prisma/schema.prisma`) is that missing record:
a row PAYNORA writes itself, server-side, the moment an OWNER requests an
upgrade — target plan, amount, currency — **before** any vendor API call.
A later webhook is matched to this row by the vendor's own payment id
(`externalPaymentId`, unique), and only ever grants the plan *this row*
recorded. It is not a second subscription system: `OrganizationSubscription`
remains the only place a plan is actually stored, and `SubscriptionPayment`
remains the only ledger of processed webhook deliveries. `BillingCheckoutSession`
is the missing link between "a checkout was requested" and "a webhook
later confirmed it," nothing more.

## Why YooKassa (ЮKassa)

`docs/provider-strategy.md`'s existing "works from Russia" priority,
unchanged since Phase 6 — PAYNORA's plan prices are RUB-denominated
(`plans.ts`), and Stripe is not usable from Russia. YooKassa is a
mainstream Russian payment processor with a documented, stable REST API.
Verified against YooKassa's own published documentation (payments API,
webhook/notification format) as of this phase — not invented.

### What YooKassa's API actually looks like (verified, not assumed)

- **Auth**: HTTP Basic, `shopId:secretKey` base64-encoded — no OAuth, no
  session tokens.
- **Creating a payment**: `POST https://api.yookassa.ru/v3/payments` with
  an `Idempotence-Key` header (YooKassa's own idempotency mechanism — a
  retried request with the same key returns the original payment rather
  than creating a second one) and a body of
  `{ amount: { value, currency }, payment_method_data, confirmation: { type: "redirect", return_url }, description, metadata, capture: true }`.
  The response includes `id` (the payment id) and
  `confirmation.confirmation_url` (where to redirect the payer).
- **No native "subscription" object.** YooKassa's model is payment-based:
  a checkout creates one real payment, not a recurring subscription
  resource. Recurring/auto-billing (charging a saved payment method
  automatically on a later date) is a distinct capability — saving a
  payment method on a first payment, then creating new one-off payments
  against it later — that Phase 20 does **not** implement. See
  "What Phase 20 does not do" below.
- **Webhooks ("notifications")**: YooKassa POSTs
  `{ type: "notification", event: "payment.succeeded" | "payment.waiting_for_capture" | "payment.canceled" | "refund.succeeded", object: { id, status, amount, ... } }`
  to a configured URL. The relevant lifecycle events for a checkout flow
  are `payment.succeeded`, `payment.waiting_for_capture`, and
  `payment.canceled` — `refund.succeeded` is out of scope (Phase 20 never
  issues refunds). A 200 response acknowledges the delivery; a non-200
  response causes YooKassa to retry for up to 24 hours.
- **No signature header.** Unlike Stripe's `Stripe-Signature`, YooKassa
  documents no HMAC/signature scheme for webhook authenticity — instead,
  authenticity is established by **source-IP allowlisting**: YooKassa
  publishes the IP ranges its webhook deliveries originate from, and a
  deployment is expected to only accept deliveries from those ranges (or
  route them through infrastructure that already enforces this).

This is the one place this phase's design differs from the brief's
suggested env var list: `YUKASSA_WEBHOOK_SECRET` was **not** added,
because it would be dead configuration for a mechanism YooKassa doesn't
have. See "Environment configuration" below for what's actually there
instead (`YUKASSA_WEBHOOK_IP_ALLOWLIST`).

## Webhook authenticity: source-IP allowlist

`src/server/billing/providers/yookassa.ts` implements real IPv4 and IPv6
CIDR matching from scratch (`isIpAllowed`, `isIpv4InCidr`, `isIpv6InCidr`
— Node has no built-in CIDR matcher) against a documented default list
(`DEFAULT_ALLOWED_CIDRS`, from YooKassa's published webhook IP ranges as
of Phase 20). **Re-verify these ranges against YooKassa's current
documentation before relying on them in production** — a vendor's IP
ranges can change over time; `YUKASSA_WEBHOOK_IP_ALLOWLIST` (comma-separated
CIDRs) overrides the default list without a code change if they do.

`src/app/api/webhooks/billing/route.ts` extracts the source IP from
`x-real-ip` (preferred) or the first hop of `x-forwarded-for`. This is
trusted only because the route is assumed reachable exclusively through
the deployment's own reverse proxy, which sets these headers itself — a
deployment that exposes this route directly to the internet without a
proxy in front of it (or behind a proxy that blindly forwards a
client-supplied `x-forwarded-for`) would make this check bypassable.
**This is a real deployment-topology assumption, not a solved problem in
code** — document your reverse-proxy configuration alongside this file
once a production deployment exists.

A request whose source IP is missing or not in the allowlist — or whose
body isn't a real YooKassa notification shape — is rejected with
`BillingWebhookVerificationError` (HTTP 401) before any state-changing
code runs.

## The checkout flow, end to end

1. An OWNER clicks "Upgrade" on a higher-ranked plan (Settings → Billing,
   `billing-actions.ts#startUpgradeCheckoutAction` — role-gated by
   `requireOrganizationRoleForPage(orgSlug, "OWNER")`, the same boundary
   every other billing mutation in this codebase uses).
2. `src/server/billing/checkout.ts#createCheckoutSession`:
   - Row-locks the `Organization` (`SELECT ... FOR UPDATE`, the same
     idiom `entitlements.ts` already uses) so two near-simultaneous
     upgrade clicks for the same organization can't both proceed.
   - Verifies the target plan is actually ranked above the current plan
     (`planRank`) — this flow only ever creates a real payment for a
     genuine upgrade.
   - Rejects if a non-stale `BillingCheckoutSession` is already `PENDING`
     for this organization (`CheckoutAlreadyInProgressError`) — a second
     concurrent/duplicate submission can't create a second real vendor
     payment. "Stale" is 1 hour (`STALE_PENDING_CHECKOUT_WINDOW_MS`),
     computed on read, no scheduler involved.
   - Creates the `BillingCheckoutSession` row — `PENDING`, amount/currency
     read from `plans.ts`'s `PLAN_ENTITLEMENTS` catalog, **never** from
     anything a client passes in — with a fresh idempotency key.
   - Calls the vendor's real checkout-creation API (outside the DB
     transaction — a single transaction cannot safely wrap a real network
     call; same two-phase claim/dispatch shape as
     `communications/send.ts`). On success, records the vendor's
     `externalPaymentId` and `checkoutUrl` on the session. On failure,
     marks the session `FAILED` (never left dangling `PENDING`, so a
     retry isn't needlessly blocked for the full stale-window) and
     rethrows.
3. The browser is redirected to the vendor's `checkoutUrl`; the payer
   completes payment at YooKassa.
4. YooKassa POSTs a webhook to `/api/webhooks/billing`. The route
   verifies it (source-IP allowlist), then calls
   `applySubscriptionWebhookEvent`.
5. The checkout-driven path (`webhook-events.ts#applyCheckoutDrivenEvent`):
   - Looks up `BillingCheckoutSession` by `event.paymentId` (the vendor's
     payment id) → `externalPaymentId`. Not found → `unknown_organization`
     (no state changes at all).
   - Verifies `checkoutSession.provider === event.eventIdentity.provider`
     — a cross-provider id collision (unlikely, but checked) resolves to
     `unknown_organization` too.
   - Records one `SubscriptionPayment` ledger row inside a transaction —
     the unique constraint on `(provider, externalEventId)` is the actual
     idempotency enforcement (a `P2002` violation is caught and reported
     as `{ outcome: "duplicate" }`, not a check-then-insert race).
   - On a succeeded outcome: a compare-and-swap
     (`updateMany({ where: { status: "PENDING" }, data: { status: "SUCCEEDED" } })`)
     inside the same transaction as the ledger insert — only the delivery
     that actually wins this CAS grants the plan
     (`OrganizationSubscription.plan = checkoutSession.targetPlanId`,
     **never** `event.planId`, which is only ever recorded in the ledger
     for audit). A second delivery for the same outcome (a hypothetical
     distinct `eventId` for the same payment) finds the session already
     `SUCCEEDED` and is a ledger-only no-op.
   - On a failed/canceled outcome: only the checkout session moves to
     `FAILED` — the organization's existing subscription (if any) is
     **never** touched. A failed *new* upgrade attempt must never revert
     an already-active plan.
   - On a pending outcome (e.g. `waiting_for_capture`): only the ledger
     row is written; nothing else changes yet.
6. Settings → Billing reflects the result: a pending checkout shows a
   "Payment pending" banner with a "Resume payment" link
   (`getLatestCheckoutSession`); a succeeded one is simply the new plan,
   now in effect, plus a new row in "Subscription payments" history; a
   failed one shows nothing special beyond the payment-history row — the
   OWNER can just click "Upgrade" again once the stale window passes (or
   immediately, since a `FAILED` session doesn't block a new one).

## Checkout-session security model (why each attack fails)

- **Cross-tenant / wrong organization.** `externalPaymentId` is unique
  per `BillingCheckoutSession`, and that session's `organizationId` is
  fixed at creation time — a webhook can only ever resolve to the one
  organization that actually requested that specific payment.
- **Client-side plan substitution.** The plan granted is always
  `checkoutSession.targetPlanId`, read from the database row PAYNORA
  itself wrote before contacting the vendor — never `event.planId`
  (a webhook-body field), and never anything a Server Action caller
  passes directly (`startUpgradeCheckoutAction` takes a `targetPlan`
  argument, but `createCheckoutSession` re-validates it against
  `planRank` server-side regardless).
- **Pay for Starter, get granted Pro.** Impossible by construction — the
  amount charged and the plan granted are both fixed at checkout-creation
  time, in the same database row; nothing about "what actually got paid"
  can retroactively change which row a webhook resolves to.
- **Forged webhook.** Rejected before any state change — source-IP
  allowlist check happens first in `verifyAndParseWebhook`, which is the
  first thing the route calls.
- **Double-applying one payment event.** The `(provider, externalEventId)`
  unique constraint on `SubscriptionPayment` is checked via a real
  Prisma `P2002` catch, not a comment-only claim.
- **Race: two concurrent webhook deliveries for the same payment.** The
  `BillingCheckoutSession` `PENDING → SUCCEEDED` compare-and-swap and the
  ledger insert happen inside the same transaction — only one delivery
  can win the CAS.
- **Race: two concurrent checkout-creation requests for the same org.**
  The `Organization` row lock inside `createCheckoutSession`'s transaction
  serializes them — the second request's own "is there already a PENDING
  session" check runs after the first has committed (or the first is
  still holding the lock, in which case the second simply waits).
- **Incorrect/spoofed vendor id.** A `paymentId` with no matching
  `BillingCheckoutSession` resolves to `unknown_organization` — nothing
  happens.

## Environment configuration

```
BILLING_PROVIDER=yookassa        # or "none" (default) / "stripe" (recognized, not implemented)
YUKASSA_SHOP_ID=                 # from your YooKassa merchant dashboard — Integration -> API keys
YUKASSA_SECRET_KEY=              # the "Live" (or "Test") secret key — NEVER commit a real value
YUKASSA_WEBHOOK_IP_ALLOWLIST=    # optional, comma-separated CIDRs — overrides the built-in default list
```

`YUKASSA_SHOP_ID`/`YUKASSA_SECRET_KEY` are required (schema-enforced,
`src/lib/env.ts`) once `BILLING_PROVIDER=yookassa` — parsing `env` fails
loudly at startup otherwise, rather than silently falling back to a
demo/fake credential. See `.env.example` for the full, documented,
secret-free template. **Not one real credential exists anywhere in this
repository.**

## Testing strategy

Every test in `src/server/billing/{checkout,webhook-events}.test.ts` and
`src/server/billing/providers/yookassa.test.ts` uses either
`createTestBillingProvider` (a deterministic, in-memory test double —
mirrors `src/server/wallet/providers/fake.ts`'s precedent; there is no
`BILLING_PROVIDER=test` value, it's only reachable by a test importing it
directly) or hand-constructed `NormalizedSubscriptionEvent`s. No test
makes a real network call to YooKassa, and no test uses fabricated
"production-shaped" payment data as a substitute for the real thing —
per the brief's "CI may only use a deterministic test provider adapter"
constraint. The YooKassa adapter's own CIDR-matching logic
(`isIpAllowed`) is exercised directly with real boundary cases (a /27's
edges, a /32 single host, a /25, IPv6's `::` shorthand), and
`createCheckout`/`verifyAndParseWebhook` are tested against realistic
YooKassa response/notification shapes with `fetch` mocked at the
network boundary only.

## What Phase 20 does not do

- **Recurring/auto-billing.** Every upgrade is a one-time checkout — there
  is no saved payment method, no automatic renewal charge, no
  subscription object at the vendor. A subscription that reaches its
  `currentPeriodEnd` does not automatically get charged again; that
  remains a distinct, unbuilt capability.
- **Stripe.** Still recognized (`BILLING_PROVIDER=stripe` parses) but not
  implemented — `resolveBillingProvider` still throws
  `BillingProviderNotImplementedError` for it.
- **Refunds.** No refund-issuing code exists; `refund.succeeded` webhook
  events are not in this adapter's `SUPPORTED_EVENTS` and are rejected.
- **Downgrade/cancel/reactivate changes.** Unchanged from Phase 19 —
  `subscription.ts`'s `changeOrganizationPlanSelfServe` still refuses any
  upgrade attempt server-side (`UpgradeRequiresPaymentError`), regardless
  of what the checkout flow above does; `cancelOrganizationSubscription`/
  `reactivateOrganizationSubscription` are untouched.
- **Production deployment.** Everything above is implemented and tested,
  but requires a real YooKassa merchant account
  (`YUKASSA_SHOP_ID`/`YUKASSA_SECRET_KEY`) and a verified production
  reverse-proxy configuration (see "Webhook authenticity" above) before
  any real money can move.

## Security review

An adversarial review of the checkout/webhook pipeline covered: cross-tenant
grants, client-side plan substitution, webhook forgery, duplicate/replay
webhooks, double-grant races, concurrent checkout-creation races,
authorization (OWNER-only), amount tampering, IP-allowlist CIDR-boundary
correctness, secret/credential exposure in error paths and logs, and
stale-session denial-of-service.

No blocking issues were found — cross-tenant isolation (unique
`externalPaymentId` lookup + provider cross-check), plan-substitution
resistance (grant always reads `checkoutSession.targetPlanId`, never
`event.planId`), webhook-verification ordering (always before any
state-changing code), replay/idempotency (`SubscriptionPayment`'s real
`(provider, externalEventId)` unique constraint, checked via an actual
`P2002` catch, not just a comment), the double-grant race (compare-and-swap
and the ledger insert inside one transaction), and the concurrent-checkout
lock (`SELECT ... FOR UPDATE` held for the whole transaction, not released
before the check) were all independently verified against the actual code,
not just their doc comments. IP-allowlist CIDR math was hand-checked at
several boundaries (`/32`, `/27`, `/25`, IPv6 `/32`, the `prefix === 0`
special case) with no off-by-one found.

One finding *was* acted on: the review noted that `applyCheckoutDrivenEvent`
recorded a webhook-reported `amountMinor`/`currency` into the ledger but
never checked it against what the checkout session was actually authorized
for — not exploitable on its own (the amount is fixed at vendor-side
payment creation, which only PAYNORA's own server ever calls), but a
worthwhile defense-in-depth layer regardless. Fixed: `webhook-events.ts`
now refuses to grant the plan (and marks the checkout session `FAILED`
instead) if a webhook's reported amount/currency doesn't match the
session's own recorded `amountMinor`/`currency` — see
`webhook-events.test.ts`'s "reported amount/currency doesn't match" test.

Two informational (non-blocking) notes remain, both documented rather than
solved, matching this codebase's existing precedent for similar
can't-fully-solve-without-bigger-machinery gaps (e.g.
`communications/send.ts`'s `UNCERTAIN` state):

- If the vendor-call HTTP request in `createCheckoutSession` times out but
  YooKassa actually created the payment anyway, the local session is
  marked `FAILED` with `externalPaymentId` still null — a legitimately-created
  vendor payment could then never be matched by its own later webhook
  (`unknown_organization`). A full fix needs vendor-side payment-status
  reconciliation (polling YooKassa for "did this actually get created"),
  a genuinely separate capability this phase does not build.
- The reverse-proxy `x-forwarded-for` trust assumption (see "Webhook
  authenticity" above) is a deployment-topology requirement, not
  something code alone can guarantee.
