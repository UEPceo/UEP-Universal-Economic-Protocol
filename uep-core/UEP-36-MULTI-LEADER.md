# UEP-36.0 — Multi-Leader + Data/Consensus Plane (LAB)

## Design (Narwhal-inspired)

| Plane | Content | Parallelism |
|---|---|---|
| **DATA** | `BATCH_HEADER` / `BATCH_BODY` | Multiple workers disseminate in parallel |
| **CONSENSUS** | digests only (`batchId`, `txDigest`, `stateRoot`, `height`) | Ordered heights; rotating leaders |

Economic state remains a **single chain**. Parallel conflicting state transitions are not finalized concurrently — availability is parallel; commit order is sequential.

## Implemented

1. `leadersForSlot` — deterministic multi-leader rotation  
2. `parallelAvailabilityRound` — 2+ workers publish batches; honest nodes see headers  
3. `consensusHeight` — rotating leader per global sequence; digest-only proposals  
4. **Bugfix:** `globalSeq` on `MultiNodeCluster` (per-worker DAG height was blocking multi-leader finality)  
5. `tryAssemble` prefers `pendingProposals` for height / previousRoot match  

## Frozen

- BFT-CLASSIC `N=3f+1` / quorum `2f+1`  
- Poseidon / SMT / ZK / fee untouched  

## NOT claimed

- Production multi-leader BFT  
- Millions TPS  
- Parallel conflicting execution without ordering  

## Next (36.1+)

- Certificate aggregation for batches of digests  
- Non-conflicting parallel execution waves after availability  
- Wire multi-leader into process-cluster (35.9) path  
