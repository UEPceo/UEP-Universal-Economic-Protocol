# UEP-36.4 — Multi-node DigestAggregate pipeline

## Integration

```
Leader
  → DATA: BATCH_HEADER + BATCH_BODY (N batches)
  → DigestAggregate
  → parallel-safe execution → stateRoot
  → PROPOSAL (aggregateDigest + batchIds)
  → votes (recompute root on each node)
  → CommitCert → Finality
  → apply all batches, one consensus height
  → all honest nodes same stateRoot
```

## API

`MultiNodeCluster.proposeAggregateFrom(leaderId, batches[])`

## DEMONSTRATED

- 4-node in-process cluster
- 2-batch aggregate → shared stateRoot
- sequential aggregates chain heights
- single-batch proposeFrom regression

## NOT YET

- Process/TCP multi-host aggregate path
- Poseidon SMT roots
- Byzantine aggregate equivocation suite

LAB only.
