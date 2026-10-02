# UEP-30.2 — Conflict scheduler & parallel waves

## Model

```
Mempool → partitionIntoWaves(conflict graph) → per wave:
  structural: parallel prove + serial commit
  ZK: sequential prove+commit within wave (roots not composable)
```

**Conflict (default):** same `sender` → conflict. Independent senders may share a wave.

## Critical insight (documented)

Two Groth16 spends proved against the **same** `old_state_root` produce **different** `new_state_root`s that **cannot both be applied**. Parallel commit requires batch/aggregate circuits (later).

ZK path therefore **chains roots inside a wave**. The scheduler still matters: same-sender jobs never share a wave; independent accounts are ordered for fairness.

## Bootstrap leaves

Circuit uses `note_commitment` for amount 0, not SMT empty leaf.

`bootstrapZeroNotes()` seeds Poseidon leaves for all accounts at **current balances** via:

- `uep-zk h-account`
- `uep-zk note-commit`
- `uep-zk low-bits`

## Tests

11/11 PASS (`test:30` includes 30.0–30.2).
