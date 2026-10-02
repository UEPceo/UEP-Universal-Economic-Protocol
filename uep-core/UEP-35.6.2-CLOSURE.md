# UEP-35.6.2 Closure

## Semantic decisions
- **BatchId** = content/availability identity (worker, epoch, height, parents, txDigest, counts).
- **StateRoot / ExecutionStateCommitment** = post-execution result.
- **CommitCert** associates epoch/height/batchId/stateRoot (existing plane).

## Fixes beyond 35.6.1
- Benchmark regenerated with `conflictEdgesIndexed`, seed, bench version, wall-clock only.
- ProducerId → NodeRegistry public key binding in authenticated accept.
- Invariant tests A–H.
- BatchId collision tests for distinct semantic fields.

## Limitations (LAB)
- Multi-node in 35.7 still uses in-process logical isolation + SimulatedNetwork (not OS processes).
- Starlink remains mock/recorded.
- Not production-ready.
