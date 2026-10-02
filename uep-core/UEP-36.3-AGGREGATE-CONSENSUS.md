# UEP-36.3 — DigestAggregate → CommitCert → Finality

## Pipeline (LAB)

```
batches
  → DigestAggregate (availability identity)
  → parallel-safe execution → newStateRoot
  → TransitionProposal (binds aggregateDigest + roots)
  → CommitVotes (BFT-CLASSIC quorum)
  → CommitCert
  → FinalityCertificate
  → apply only after verifyCommitCert
```

## Guarantees demonstrated

- Aggregate is **input**, not finality
- Proposal digest binds aggregate + previous/new state roots
- Insufficient votes → CommitCert fails
- Tampered aggregateDigest → different proposal digest
- Multi-height chain with certified apply

## NOT yet

- Integration into MultiNodeCluster / process TCP path
- Poseidon SMT state roots
- Production BFT under partitions
- True concurrent execution

Poseidon / SMT / ZK / fee / BFT params unchanged.
