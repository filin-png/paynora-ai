# Exit Readiness

PAYNORA is being built as a commercial asset with an initial target exit
value of 800,000–1,000,000 RUB minimum, with architecture that doesn't
artificially cap a higher valuation. This document tracks progress toward
that, honestly — a target is not an achievement.

## Current status: Phase 0, pre-revenue

- Paying customers: 0
- MRR: 0
- Founder dependency: total for the *business* (no customers, no revenue,
  no operating history to hand over yet)
- Technical due-diligence readiness: partial — the codebase itself now has
  real, tested provider boundaries, tenant isolation, and a documented
  security/dependency review history (see the checklist below); what's
  still missing is the *business* side of due diligence (revenue,
  customers, operating history), not the code

## Target metrics (from the project brief — targets, not guarantees)

**Initial validation**
- First real users
- First paying customer
- 10 paying customers

**Next milestone**
- 25+ paying customers

**Exit-ready baseline**
- MRR ≥ 60,000 RUB
- Net margin ≥ 60%
- 25+ paying customers
- Monthly churn < 5%
- ≥ 3 months stable revenue
- No single customer > 15% of MRR
- Automated onboarding
- Production monitoring
- Complete operational documentation

**Target exit profile**
- MRR ≈ 100,000–150,000+ RUB
- Monthly profit ≈ 70,000–100,000+ RUB
- 40–80+ paying customers
- 6–12 months revenue history
- Low founder workload
- Documented acquisition channels
- Clean technical due diligence

## Due-diligence checklist (tracked as it becomes true, not before)

- [ ] Product functions without founder intervention for day-to-day operation —
      automation, plan changes, and support requests still require a human
      (founder or org owner) to act; see "What's still genuinely open" in
      `ROADMAP.md`.
- [x] Provider boundaries mean no vendor is a single point of failure (see
      `docs/provider-strategy.md`) — AI has primary+fallback across
      distinct vendors, Email is vendor-neutral SMTP, Messaging/Wallet are
      each behind their own swappable provider interface.
- [x] Tenant isolation has automated test coverage — every domain module
      added across every phase, including Phase 17's AR export and
      support-request workflow, carries its own explicit cross-tenant
      test (see any `*.test.ts` file's "tenant-scoped"/"tenant isolation"
      cases).
- [x] Security review completed (see `SECURITY.md`) — an initial
      adversarial audit (`docs/audits/PAYNORA-AUDIT-V1.md` +
      remediation) plus a repeated per-phase adversarial-review practice
      since. Treat this as an ongoing practice, not a single closed
      artifact — a genuinely new attack surface (e.g. a future real
      payment integration) still needs its own dedicated pass.
- [x] Dependency and license review completed — see
      `docs/dependency-license-review.md` (Phase 17). Point-in-time, like
      the security review above: re-run periodically, not a one-time fact.
- [ ] Financial exports available (revenue, churn, customer list) — the
      *mechanism* exists (Phase 17: organization-level customer/invoice/
      payment CSV export, and a founder-only subscription/plan-roster
      report) and is real and tested, but a revenue/churn export is not
      yet meaningful: there is no real billing provider or price
      connected, so real revenue is $0 today — see
      `docs/commercial-readiness.md`.
- [ ] Operational documentation complete (this doc set + runbooks) — the
      architecture/design documentation is extensive; incident-response
      runbooks specifically do not exist yet.
- [ ] No customer concentration risk (single customer > 15% of MRR) — not
      yet applicable: there are no paying customers yet.

Every unchecked box above is real — this document is updated as work lands
in later phases, not written to look complete now. Checked boxes reflect
verified facts as of this update (2026-09-04, Phase 17) — re-verify before
relying on any of them in an actual due-diligence conversation, since
"was true when documented" is not the same guarantee as "is true right
now."
