# Category module integration notes (adapted from the incoming adapted-modules package)

> Renamed in v0.5.3 from `docs/AUDIT-FIXES.md`. These are internal integration notes, not an audit.

Status: historical design notes for the v0.5.2 category integration. The
integrated modules supersede the incoming package. Residual limits are listed
in `../CATEGORY-MODULES.md` and `../INTEGRATION-PLAN.md`.

Confirmed choices in this repository:

- Forfeited/slashed bonds: 80 % injured party / 20 % treasury RISK_RESERVE.
- Forfeiture only with `frivolous: true` on a full loss.
- Dispute timeout default refunds the buyer (`defaultReleaseBps: 0`).
- Bond `max(50, 1 % of escrow)`; one dispute per order.
- Drip at most 50 % of the order's marketplace fee, once per order.
- Quorum is a strict majority.
- Relay custody tranche 20 % once the committed key is published.


> v0.5.3 note: the dispute timeout default no longer applies to a relay order after `KEY_RELEASED` (the order resumes; V52-01) and a timeout pays 20 % of the claimant's bond to the respondent. See `../CATEGORY-MODULES.md`.
