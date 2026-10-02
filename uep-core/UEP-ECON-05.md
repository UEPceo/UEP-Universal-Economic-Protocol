# UEP-ECON-05.1 — Canonical economic tip + obligation/settlement + expiry

## P0 — Canonical economic tip (consensus path)

```
economicTipCommitment = H(
  UEP-ECON-TIP-05 |
  stateRoot | nullifierRoot | height |
  appliedTx | authNonces | holds | obligations | treasury
)
```

- Implemented on **LocalEconomicState** and **SmtEconomicState**.
- `MultiNodeCluster.requireEconomicCommitment = true`:
  - proposals include `economicCommitment`
  - voters recompute tip after applying txs
  - proposal digest binds the tip
- `stateRoot` remains account SMT / LAB root (ZK compatibility).

**Regressions:** same balances + different holds/appliedTx → different tips; multinode finality OK.

## P1 — Obligation ↔ hold

```
ACCEPT → hold_open + ObligationRecord OPEN
DELIVERY → markDelivered (digest match) → DELIVERED
SETTLEMENT → hold_consume → CONSUMED + SETTLED
```

`hold_consume` with an obligation record requires **DELIVERED**.
Rejects: before delivery, double consume, expired hold, wrong price/provider.

`buildAcceptWithHold()` builds linked obligation + hold tx.

## P2 — Deterministic expiry (height, not Date.now)

- `deliverByHeight` / `settleByHeight` on obligation.
- Default TTL: `DEFAULT_HOLD_TTL_HEIGHTS = 64`.
- On every `applyTransfers`, `runDeterministicExpiries`:
  - HELD past deadline → **EXPIRED** (available restored; balance never moved)
  - OPEN obligation past `deliverByHeight` → **EXPIRED**
- Explicit `hold_expire` kind also available when height ≥ deadline.

## P3 — Hold integrity

| Status | Balance | Available |
|--------|---------|-----------|
| HELD | unchanged | − locked |
| RELEASED / EXPIRED | unchanged | restored |
| CONSUMED | − locked | 0 for that hold; provider +price; treasury +fee |

`locked = price + feeLocked`. Terminal statuses never return to HELD.

## NOT in 05.1

- Multi-asset `assetId` (P4) — design only
- Fee→validator split (P5)
- Stronger auth covering holdId (P6) — partial via existing TX auth
- Cross-domain economy (P7)
- Service proof levels 1–3 (P8)
- 100-civ adversarial sim (P9)
- CLIENT_WINS / PROVIDER_WINS balance effects

## Tests

`test:econ-05` → 11/11 PASS · `test:econ-04` → 9/9 PASS
