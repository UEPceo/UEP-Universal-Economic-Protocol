# UEP-35.7 — Multi-Node Foundation (LAB)

## Architecture
IndependentNode: identity, mempool/worker, DAG, ready set — **no shared app memory**.
SimulatedNetwork: seeded latency/loss/dup/reorder/partition/heal.
DATA plane: BATCH_HEADER broadcast → BATCH_BODY_REQ → BATCH_BODY.
CONSENSUS plane: existing CommitCert/FinalityCert (not redesigned).

## Demonstrated
- 4-node header+body recovery convergence
- Invalid signature reject
- Partition → heal → converge
- Byzantine node ignored by honest path
- Message stats at 8 nodes

## Not claimed
- Global production network
- Full BFT redesign
- Millions of TPS
