# UEP-36.6 — Partition / Heal with DigestAggregate

## Scenarios

| Scenario | Expected |
|---|---|
| 3\|1 partition + aggregate | Majority finalizes; minority sequence=0 |
| Heal + resync | All honest same stateRoot |
| 2\|2 partition | No BFT-CLASSIC finality (quorum=3) |
| Process 3\|1 | Same as in-process over TCP |
| Process heal | Catch-up via PROPOSAL + COMMIT/FINALITY + bodies |

## Fixes for aggregate catch-up

- `resyncCerts` rebroadcasts **PROPOSAL** (with `batchIds`) before certs
- COMMIT_CERT payload includes optional `batchIds`
- Lagging peers reconstruct minimal pending for `applyProposalBatches`
- MultiNodeCluster: `partition` / `heal` / `resyncAfterHeal`

## LAB only

Not a production partition-tolerant BFT proof. Demonstrates recovery path for aggregate state.
