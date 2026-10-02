# UEP-36.1.2 — Execution Semantics + Payload Closure

## Sequential ≡ scheduled

| Path | How |
|---|---|
| **Sequential** | `applyBatch(all txs in original order)` → height +1 |
| **Scheduled** | waves → `applyTransfers` each → `commitLogicalHeight()` once |

`fullStateEqual`: balances + treasury + height + stateRoot.

## Waves ≠ consensus heights

```
Consensus height N
  → batch / aggregate
  → Wave1, Wave2, Wave3  (transfers only)
  → commitLogicalHeight → StateRoot at height N+1
```

## DigestAggregate (official proposal)

```json
{
  "kind": "DIGEST_AGGREGATE",
  "version", "epoch", "height", "previousStateRoot",
  "aggregateDigest",
  "entryDigests": [{ "batchId", "txDigest" }]
}
```

- No execution `stateRoot`
- Entries **canonicalized by batchId** (availability set, not execution order)
- Strong payload validation + integrity check

## DEMONSTRATED
- sequential/scheduled state equivalence
- single height regardless of wave count
- official DIGEST_AGGREGATE only
- reproducible benchmark phases

## NOT YET
- CommitCert integration of aggregate
- true concurrent execution
- production BFT / Poseidon SMT / global TPS
