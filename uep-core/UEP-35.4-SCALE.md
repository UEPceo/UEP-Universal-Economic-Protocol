# UEP-35.4 — Propagation / Execution at Scale (LAB)

## Architecture

```
Intake (mempool)
   → Batch formation (max size / FIFO)
   → Conflict waves (partitionBySender)
   → Structural ExecutionEngine (parallel proveConcurrency)
   → BatchHeader digest (SHA-256)
   → Header bus (dedup fan-out)
```

## Explicitly out of scope (still)

- Per-TX Groth16 in the hot path
- Production P2P / epidemic gossip
- Recursive proof aggregation
- Changing Poseidon, fee, D=32, BFT 3f+1

## Measured (structural lab)

1000 TX / 100 accounts / batch 128 → ~10k+ TX/s class on single process (wall-clock dependent).

## Next (35.5+)

- DAG dissemination of batch bodies
- Link batch commit to FinalityCertificate
- Optional ZK aggregation research (not required for structural scale)
