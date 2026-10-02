# UEP-ECON-04.0 — On-chain hold / escrow

## Semantics
- `available(C) = balance(C) − held(C)`
- `held` from HoldRecords with status HELD in economic state
- Protocol BatchTx kinds: `hold_open` | `hold_release` | `hold_consume` | `transfer`

## Invariants
- Transfer cannot spend locked funds (F-2)
- Second hold rejected if insufficient available
- Consume: debit client price+fee, credit provider + treasury, status CONSUMED (atomic)
- holdsCommitment in canonicalStateCommitment (SMT)

## Not in 04.0
- expiresAtHeight (F-5) → 04.1
- ECON-02 auto-wiring accept→hold_open (use builders)
- SpendCircuit hold witnesses
- Multi-asset

## Tests
test:econ-04 → 9/9 PASS
