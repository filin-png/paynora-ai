# Exit Readiness

PAYNORA is being built as a commercial asset with an initial target exit
value of 800,000–1,000,000 RUB minimum, with architecture that doesn't
artificially cap a higher valuation. This document tracks progress toward
that, honestly — a target is not an achievement.

## Current status: Phase 0, pre-revenue

- Paying customers: 0
- MRR: 0
- Founder dependency: total (nothing exists to hand over yet)
- Due-diligence readiness: not applicable — no product to diligence

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

- [ ] Product functions without founder intervention for day-to-day operation
- [ ] Provider boundaries mean no vendor is a single point of failure (see `docs/provider-strategy.md`)
- [ ] Tenant isolation has automated test coverage
- [ ] Security review completed (see `SECURITY.md`)
- [ ] Dependency and license review completed
- [ ] Financial exports available (revenue, churn, customer list)
- [ ] Operational documentation complete (this doc set + runbooks)
- [ ] No customer concentration risk (single customer > 15% of MRR)

Every unchecked box above is real — this document is updated as work lands
in later phases, not written to look complete now.
