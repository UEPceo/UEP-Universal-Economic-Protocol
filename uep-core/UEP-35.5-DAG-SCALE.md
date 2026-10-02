# UEP-35.5 — DAG / Worker Dissemination + Batch Finality Binding

**Baseline:** v35.4 scale pipeline (frozen).

## Pipeline demonstrated

```text
TX → Worker (mempool) → Batch + DAG header
  → availability / recovery
  → ConflictGraph waves
  → sequential ≡ parallel execution
  → ExecutionStateCommitment (post-state)
  → TransitionProposal binding
  → CommitCert → FinalityCert
  → applyOnFinal (ExecutionEngine)
```

## Planes

| Plane | Components |
|---|---|
| **DATA** | UepWorker, ScaleMempool, BatchDag, recovery |
| **CONSENSUS** | existing CommitCert / FinalityCert (reused) |

Workers **do not** decide finality.

## ExecutionStateCommitment

LAB SHA-256 over sorted balances + treasury + engine stateRoot + accepted ids.  
**Does not** change Poseidon/SMT parameters. Interface for future SMT post-root.

## Invariants

- maxBatchSize **and** maxBatchBytes on `takeBatch`
- TX > maxBatchBytes → reject at admit (never blocks mempool)
- Mempool dedup ≠ nullifier/transition replay protection
- Parallel waves ≡ sequential economic snapshot
- Cert must match batch binding + postStateRoot + height

## LAB only

Single-process benchmarks are **not** network TPS.
