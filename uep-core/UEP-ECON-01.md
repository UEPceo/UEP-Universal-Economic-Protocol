# UEP-ECON-01 — Economically meaningful transaction (lab)

## Rationale

1. **Problem:** after the 37.x milestones the lab had roots and consensus, but
   had not yet shown that a finalized transaction moves value, charges a fee and
   credits the treasury in a readable way.
2. **Autonomy:** the protocol fee is the first element of infrastructure
   sustainability (no native token).
3. **Economic sanity:** conservation of `sum(accounts) + treasury` is invariant;
   the fee is `creatorFee(amount)` from `src/core/fee.ts`.
4. **Relation to a real transaction:** propose → multi-node finalize → balances
   + treasury + state root.
5. **Why now:** it rebalances the work after the 37.7.x consensus milestones.
6. **Complexity:** reuses `creatorFee`, `SmtEconomicState` and
   `MultiNodeCluster`; no token, no new BFT logic.

## Definition

A transaction is **economically meaningful** if:

- `fee = creatorFee(amount) > 0`. Under the current core rule
  `fee = max(1, floor(amount / 1000))`, this holds for every positive amount;
- tracked supply is conserved;
- sender debit = amount + fee; recipient credit = amount; Δtreasury = fee;
- `stateRoot` changes after finality on honest nodes.

## Receipt

`EconomicReceipt` (`src/lab/uep-econ-01.ts`): before/after snapshot, fee, deltas, flags.

## Tests

`src/lab/uep-econ-01.test.ts` (5 tests; run with `npm run test:lab -- uep-econ-01`).

| Case | Expected |
|------|----------|
| Fee policy: 1000 → 1, 999 → 1 (1-unit floor) | pass |
| Structural 5000 → treasury 5, conservation | pass |
| Poseidon/ZK path 2000 → meaningful | pass |
| Small amount 500 → fee 1, meaningful | pass |
| Insufficient funds → no proposal, no state change | pass |

Historical note: before the 1-unit fee floor (v0.4.4), amounts below 1000 paid
no fee and were classified as "valid but not meaningful".

## Not covered

- Verifiable settlement of an external service
- Remuneration of provers or relayers
- A native token
- Interplanetary economics

Next step: **ECON-02 service settlement**.
