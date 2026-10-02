# UEP-35.11 — Multi-Process Partition + Recovery

## Goal
Demonstrate partition safety and heal/resync on the **process-per-node** path (35.9), not only SimulatedNetwork.

## Mechanisms
1. **Logical partition** — `TcpMeshEndpoint.blockPeer` drops send + receive for listed peers (sockets stay up; traffic filtered).
2. **Heal** — clear blocks.
3. **Resync** — nodes rebroadcast known `COMMIT_CERT`, `FINALITY_CERT`, headers and bodies so lagging peers catch up under existing verification rules.

## Demonstrated
| Scenario | Result |
|---|---|
| Mesh block | Messages to blocked peer not delivered |
| Partition 3\|1 | Majority finalizes; isolated has 0 finality |
| Heal + resync | All 4 processes → same `stateRoot` + finality |

## Safety properties (LAB)
- No finality without CommitCert verification. 
- Isolated minority cannot invent a conflicting global final state that majority adopts without heal path.
- After heal, recovery uses verified certificates only.

## Still LAB
- Partition is soft (filter), not OS-level network cut.
- Single physical host.
- Economic state still LocalEconomicState (not Poseidon SMT).
