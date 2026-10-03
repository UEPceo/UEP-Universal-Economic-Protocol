> Historical: describes the 12-input circuit with 152_621 constraints. The current circuit (v3, with `domain_id` and the fee floor) measures 153_956 constraints at D=32 and 46_660 at D=4; see `uep-26-spend-circuit/README.md`.

# UEP-30 — Execution Engine & Scalability

**Status:** 🟢 IN PROGRESS (30.0 foundation)  
**Depends on:** UEP-29.4 CLOSED (real D=32 prove timings)  
**Does NOT change:** Poseidon params, D=32, 152621 constraints, fee formula, bindings, 12 public inputs.

## Design input (measured)

| Depth | prove_ms | sequential TX/s |
|---|---|---|
| D=4 | ~2.0 s | ~0.22 |
| D=32 | ~7.8 s | ~0.059 |

Sequential single-process proving cannot reach high throughput. Parallelism must sit **outside** the circuit.

## Architecture (30.0)

```
SpendIntent
    │
    ▼
 MEMPOOL (ordered intake + balance reservation)
    │
    ├──────────────┬──────────────┐
    ▼              ▼              ▼
 ProveWorker    ProveWorker    ProveWorker   (concurrency N)
    │              │              │
    └──────────────┼──────────────┘
                   ▼
          CONFLICT CHECK (nullifier, transitionId)
                   ▼
          SERIAL COMMIT (deterministic order)
                   ▼
             State / balances
```

### Invariants

1. **Prove ∥ parallel** — independent intents with reserved balances.
2. **Commit ∥ serial** — one writer; nullifier set is authoritative.
3. **Idempotency** — same `transitionId` committed once.
4. **No SKIP** — ZK mode without `uep-zk` fails the job, does not skip.
5. **DEV keys** remain tagged; not production ceremony.

### What 30.0 delivers

| Piece | Status |
|---|---|
| Mempool + reservation | 🟢 |
| Parallel prove pool | 🟢 |
| Serial commit + conflicts | 🟢 |
| Structural throughput test | 🟢 |
| Optional D=4 parallel ZK | 🟢 if binary present |
| Persistent mempool / P2P | 🔴 later |
| Batch circuits / aggregation | 🔴 later (30.x) |

### Throughput expectation (ideal, no conflicts)

`TX/s ≈ N_workers / prove_seconds` (commit overhead negligible vs prove).

Example D=32, prove 7.8 s, N=8 → ~1 TX/s theoretical on one host (RAM permitting).
Millions/TX requires many hosts + batching/aggregation research — not this slice.

## Fee note

Protocol fee (0.1%) is unchanged. Scalability work does not retune fee policy.

## UEP-30.1 — One in-flight per sender + scale bench

### Policy

When `requireProof` (or `oneInFlightPerSender: true`):

- At most **one pending/proving job per sender label**.
- Second enqueue → `ONE_IN_FLIGHT_PER_SENDER`.
- After commit, sender may enqueue again.

**Why:** current ZK witness builds a mini-tree from `sender.balance` snapshot. Two parallel proves from the same sender would claim the same leaf / inconsistent nullifiers.

### Scale benchmark

```bash
npm run bench:30.1                  # structural, concurrency 1..8
npm run bench:30.1 -- --prove --tx=4  # D=4 Groth16, concurrency 1 and 2
```

Evidence → `artifacts/uep-30.1-evidence/`.
