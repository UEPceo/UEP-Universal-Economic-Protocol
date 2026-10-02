# UEP-36.9 — Soft Restart + Vote-Lock Durability

## Soft restart

Clears ephemeral de-dupe (`seenMsgIds`, `seenVotes`, pending) while **restoring**:

- `HeightVoteLock` snapshot
- Economic tip (sequence, stateRoot) — already applied in durable sense (LAB memory)

## API

- `snapshotNodeConsensus(node)`
- `softRestartNode(node, snap?)`
- `MultiNodeCluster.softRestart(nodeId)`

## Demonstrated

- Lock survives restart → conflicting digest at same height still REJECT
- Minority soft-restart → next height still converges
- Partition + isolated restart + heal + next leader → same root

## NOT YET

- On-disk WAL / RocksDB
- Process crash recovery with reload from disk
- Poseidon SMT tip persistence

LAB only.
