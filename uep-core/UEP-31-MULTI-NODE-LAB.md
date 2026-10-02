# UEP-31 — Multi-node Lab (sequencer + replicas)

**Status:** 🟢 in-process + TCP (localhost) — superseded in part by **UEP-32**

## Model

- One **sequencer** orders transitions and signs `NodeEnvelope`.
- **Replicas** apply only if `previous_state_root == local` and signature verifies.
- Catch-up replays sequencer log after downtime.
- **TCP transport** (31.1): star topology, length-prefixed JSON, ports dynamic / 127.0.0.1.

## UEP-32 upgrades (current)

- **Ed25519** node identity (HMAC lab removed from envelope path)
- **NodeRegistry** (node_id, pubkey, network, domain, role, status)
- **Handshake** HELLO → CHALLENGE → AUTH → OK

## Explicitly not implemented

- **FAILOVER NOT IMPLEMENTED** — sequencer failure is flagged only
- BFT / leader election
- TCP beyond localhost (LAN/Internet + TLS)
- Shared payment anti-replay across nodes
