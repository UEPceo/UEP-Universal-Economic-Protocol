# UEP-35.8 — TCP Multi-Host Consensus Lab

## Goal
Move 35.7.1 consensus from SimulatedNetwork to **real TCP sockets** (localhost multi-port).

## Demonstrated
- TcpMeshEndpoint: length-prefixed JSON frames
- TcpConsensusCluster: 4 nodes, full mesh dial
- PROPOSAL → VOTE → CommitCert → FinalityCert over TCP
- Honest nodes: same stateRoot + finalized

## Still LAB
- Same process, multiple ports (not separate OS processes / machines)
- LocalEconomicState ≠ Poseidon SMT
- localhost only

## Not yet
- Multi-machine deployment
- Process isolation (child_process)
- Production gossip / NAT
