# Terms of Service (Foundation — Phase 15A)

> **This is a structural foundation, not a finished legal instrument.**
> Every section requiring a real legal entity, jurisdiction, or contact
> detail is marked `[TO BE COMPLETED]`. This document does not create a
> binding contract on its own — see `docs/privacy-policy.md` for the
> same framing applied to data handling.

## 1. Service description

PAYNORA is accounts-receivable and collections-automation software for
B2B service businesses: tracking invoices and customers, drafting and
sending payment reminders (with human approval required before any send
— see `docs/communications.md`), and optionally reconciling
cryptocurrency payments (`docs/wallet-architecture.md`).

## 2. Account

A user registers with an email and password (bcrypt-hashed, never stored
in plaintext). One user can belong to multiple organizations with
different roles (`OWNER`/`MEMBER`) — see `docs/identity-and-tenancy.md`.

## 3. Organization usage

An organization's data (customers, invoices, payments, communications)
is scoped to that organization and isolated from every other
organization at the data-access layer — independently tested
(`docs/identity-and-tenancy.md`'s tenant-isolation test suite). An
`OWNER` can manage members, billing, and organization-wide settings; a
`MEMBER` has narrower access — see `docs/domain-model.md`.

## 4. Acceptable use

`[TO BE COMPLETED]` — a specific acceptable-use policy (prohibited
content, rate limits beyond the technical ones already enforced,
prohibited industries) is a business/legal decision, not something this
codebase infers from its own architecture.

## 5. Financial data disclaimer

PAYNORA is a records and communication tool — it does not process
payments directly, hold funds, or provide accounting/tax/legal advice.
Amounts are stored as exact integers (never floating-point) and
formatted for display only — see `docs/accounts-receivable.md#money-representation`.
Users remain responsible for the accuracy of the financial data they
enter and for their own accounting/tax obligations.

## 6. AI limitations

AI-assisted content (reminder drafts, priority summaries) is generated
by a third-party AI provider and may be inaccurate or inappropriate for
a given situation — a human must review and approve every AI-assisted
communication before it is sent; PAYNORA never sends one automatically
without that approval (except an organization's own explicit, narrowly-
scoped `AUTO_SEND` opt-in for allowlisted actions — see
`docs/collections-automation.md`). AI-generated priority/tone is a
suggestion, never a financial determination.

## 7. Web search limitations

When enabled, web search results are retrieved from third-party sources
in real time and may be inaccurate, incomplete, or out of date at the
moment of use. Cited sources are never fabricated (`docs/production-integrations.md#web-intelligence`),
but the underlying content itself is exactly as reliable as whatever the
web page in question actually says — PAYNORA does not verify third-party
web content for accuracy.

## 8. Wallet / blockchain risks

Cryptocurrency transactions are irreversible and PAYNORA has no ability
to reverse, cancel, or recover a transaction sent to the wrong address
or asset. PAYNORA never holds a private key or seed phrase and never
signs a transaction on a user's behalf — see
`docs/wallet-architecture.md#4-security-model`. Blockchain network fees,
confirmation times, and asset volatility are outside PAYNORA's control.
Underpayment/overpayment and reconciliation behavior is deterministic
and documented (`docs/wallet-architecture.md#10-financial-invariants`),
not a guarantee against user error (e.g. sending the wrong asset).

## 9. Third-party providers

PAYNORA integrates with the third-party services listed in
`docs/subprocessors.md`. Each is optional and configured per deployment;
using PAYNORA with a given provider enabled means that provider's own
terms of service also apply to that specific interaction.

## 10. Availability

`[TO BE COMPLETED]` — no uptime commitment (SLA) is defined by this
codebase; availability depends entirely on how and where a given
deployment is hosted.

## 11. Liability

`[TO BE COMPLETED]` — limitation-of-liability language requires legal
drafting specific to the operating entity's jurisdiction.

## 12. Termination

`[TO BE COMPLETED]` — the technical account-deletion mechanism exists
(`docs/privacy-policy.md#17-data-deletion`); the contractual terms under
which an account or organization may be suspended/terminated are a
business decision, not inferred from the code.

## 13. Intellectual property

`[TO BE COMPLETED]` — ownership of PAYNORA's own software vs. a
customer's own data (customers, invoices, communications) is a legal
statement this document does not make unilaterally; as a factual matter,
every organization-scoped record in the database belongs to that
organization and is never used for any purpose beyond providing the
product to it (see `docs/privacy-data-inventory.md`).

## 14. Governing law

`[TO BE COMPLETED]` — depends on the operating entity's jurisdiction.

## 15. Contact

`[TO BE COMPLETED]` — depends on the operating entity from §14.
