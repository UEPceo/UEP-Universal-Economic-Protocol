# UEP-32 — Authenticated Multi-Node Lab

**Status:** 🟢 Ed25519 + registry + handshake (localhost TCP)

## 32.1 Ed25519 identity

`createNodeIdentity(nodeId)` → private/public keypair.  
Envelopes: `Sign(privateKey, body)` / `Verify(registry[sequencer].publicKey, …)`.

## 32.2 Node registry

```
node_id | public_key | network | domain | role | status
```

## 32.3 Handshake

HELLO → CHALLENGE(nonce) → AUTH(sig) → auth_ok | auth_reject

## 32.4–32.7

| Item | Status |
|---|---|
| TCP localhost | 🟢 |
| TCP multi-host | 🔴 next |
| Crash catch-up | 🟢 lab |
| Sequencer failure | 🟠 **FAILOVER NOT IMPLEMENTED** (detect only) |

## Protocol version

`NODE_PROTOCOL_VERSION = 2` (Ed25519 envelopes).

## 32.3b Handshake on TCP socket

Implemented in `node-auth-transport.ts`:

1. Replica connects
2. Sends HELLO
3. Sequencer CHALLENGE
4. Replica AUTH (Ed25519)
5. auth_ok { authenticatedNodeId, responderNodeId }
6. Only then envelopes / catchup on that socket

Unknown / revoked nodes: handshake fails, no state applied.

## 32.4 Multi-host ready

`listenHost: "0.0.0.0"` supported. Lab tests still use 127.0.0.1.
TLS / discovery still 🔴.

## E2E pipeline

`runPaymentToReplicaE2E`:

PaymentRequest → SpendIntent → ExecutionEngine → NodeEnvelope → Auth replica

Structural path tested (requireProof: false).
