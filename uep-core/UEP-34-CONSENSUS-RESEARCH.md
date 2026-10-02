# UEP-34 — Consensus & Failover (lab foundation)

## Problem

UEP-33 demonstrated:

```
sequencer → replicas (verify + apply) → same state
```

If the sequencer dies, the lab **stops**. Failover is required before public testnet.

## Design choice for 34.0 (lab)

**Deterministic candidate rotation** (Raft-like single leader), not full BFT:

| Approach | Byzantine tolerance | Complexity | UEP-34.0 |
|---|---|---|---|
| Raft / leader + log | Crash faults | Medium | ✅ lab path |
| PBFT / HotStuff | f < n/3 Byzantine | High | 🟡 research later |
| Nakamoto PoW | probabilistic | High / energy | ❌ not aligned |
| Stake voting | economic | High + token pressure | ❌ avoided for now |

**Policy:** ordered `candidates[]`. On timeout, `nextCandidate` signs `NewLeader` for `epoch+1`. Replicas accept only envelopes signed by the current epoch leader key.

## Explicit non-claims

- Not safe under arbitrary network partitions + malicious majorities.
- Not a production finality gadget.
- Does not replace ZK verification of economic transitions.

## Path

```
34.0  election + failover lab (N candidates)
34.1  heartbeat / timeout detection over TCP
34.2  quorum certificates (optional step toward BFT)
34.x  research HotStuff-style if multi-domain needs it
35.x  scalability (batch / aggregate / partition)
```

## Throughput note

Failover improves **availability**, not **TPS**. Millions of TX/s remain a UEP-35 problem.

## 34.1 Heartbeat (implemented)

- Signed `Heartbeat` from current epoch leader
- `HeartbeatMonitor` timeout → `onSilence`
- Lab: pulse keeps monitors quiet; silence without pulse

## 34.2 Quorum cert (implemented)

- Majority of candidates (`floor(n/2)+1`) must sign the same NewLeader body
- Single-node epoch change rejected
- `failoverWithQuorum()` in lab

Still **not** full BFT under adversarial partitions.
