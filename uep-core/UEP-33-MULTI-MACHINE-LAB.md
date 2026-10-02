# UEP-33 — Multi-machine / multi-process Testnet Lab

**Status:** 🟢 3-node lab (independent AuthNetworkNode instances + disk persistence)

## What is demonstrated

| Check | Status |
|---|---|
| 3 nodes: sequencer A + replicas B, C | 🟢 |
| Same state root / sequence / nullifier root | 🟢 |
| Ed25519 + auth TCP | 🟢 |
| Tampered envelope rejected | 🟢 |
| Replica disconnect → catch-up | 🟢 |
| Disk persist + reload | 🟢 |
| Groth16 on path | 🟢 via 32.5 E2E (cluster structural by default) |
| Physical 3-host over LAN | 🟡 same code; run with `listenHost=0.0.0.0` + real IPs |

## Architecture

```
NODE A (sequencer)
   TCP
  /   \
 B     C
replicas
```

**FAILOVER NOT IMPLEMENTED** — if A dies, B/C do not elect a leader.

## Multi-host recipe (manual)

1. Share genesis: NodeRegistry pubkeys + VerifyingKeyRegistry pins.
2. On A: `listenHost=0.0.0.0`, role=sequencer.
3. On B/C: connect to `A_LAN_IP:port` after HELLO/AUTH.
4. Commit ZK TX on A; B and C must Groth16-verify then APPLY.

## Tests

```bash
npm run test:33      # structural + ZK
npm run test:33.zk   # ZK cluster only
```

Structural cluster 4/4 + ZK pipeline 3/3 (see UEP-33.1-ZK-CLUSTER.md).
