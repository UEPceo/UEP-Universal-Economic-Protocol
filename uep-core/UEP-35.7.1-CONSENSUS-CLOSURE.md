# UEP-35.7.1 — Consensus + State Convergence Closure

## DEMONSTRATED (LAB)
- PROPOSAL → VOTE → CommitCert → apply → FinalityCert
- CommitCert bound to batchId + stateRoot + height
- DAG_READY ≠ COMMITTED ≠ FINALIZED
- Honest nodes share same economic stateRoot after finality
- Per-node NodeRegistry copies (no shared object)
- Authenticated consensus envelopes (sender, epoch, height, digest, sig)
- BFT-CLASSIC n=4 → quorum 3
- Partition: no conflicting finality among honest
- Byzantine wrong_root does not finalize DEADBEEF on honest nodes
- Vote replay/dup not double-counted (seenVotes / msgId)

## SIMULATED
- SimulatedNetwork (single process)
- LocalEconomicState SHA commitment (not Poseidon SMT)
- Logical nodes (not OS processes)

## NOT YET
- Production BFT under async partitions
- Multi-host TCP consensus path
- Millions TPS / global scale
- Ceremony Groth16

## NO TOUCH
Poseidon, SMT, ZK, fee, treasury, wallet.
