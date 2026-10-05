# Category module audit notes (adapted from incoming adapted-modules)

Status: historical design notes for the v0.5.2 category integration. The
integrated modules supersede the incoming package. Residual limits are listed
in `docs/CATEGORY-MODULES.md` and `docs/INTEGRATION-PLAN.md`.

Confirmed choices in this repository:

- Forfeited/slashed bonds: 80 % injured party / 20 % treasury RISK_RESERVE.
- Forfeiture only with `frivolous: true` on a full loss.
- Dispute timeout default refunds the buyer (`defaultReleaseBps: 0`).
- Bond `max(50, 1 % of escrow)`; one dispute per order.
- Drip at most 50 % of the order's marketplace fee, once per order.
- Quorum is a strict majority.
- Relay custody tranche 20 % once the committed key is published.
