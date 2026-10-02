# UEP-Agent Foundation (EXPERIMENTAL)

**Status:** experimental module — **not** part of consensus, SpendCircuit, fee policy, or wallet production path.

## Purpose

Allow future AI agents to act as **constrained economic actors** on UEP:

```
Human → Wallet (owner) → AI Agent (capability grant) → UEP settlement → Service
```

## Identity & authorization

| Field | Role |
|---|---|
| `agent_id` | Stable agent identifier |
| `public_key` | Ed25519 agent key |
| `owner/controller` | Human/org that funds payments |
| `permissions` | discover, compare, contract, pay, verify, settle |
| `spending_limit` | Max single payment |
| `remaining_budget` | Grant window budget |
| `allowed_assets` / `allowed_services` | Allow-lists |
| `expiry` / `revocation` | Time-bound + kill switch |
| `nonce` | Replay protection |

## Security invariants

1. Agent **never** holds unlimited wallet access.
2. Payments debit **owner** wallet under capability check.
3. Agent **cannot** self-escalate permissions.
4. Revoked / expired / over-limit / wrong service → REJECT.

## Simulation

`AgentEconomySim` + `runAgentExperiment(n)` exercise discovery → settlement and abuse probes.

## Future integration (not now)

- Bind capability to real PaymentRequest / SpendIntent
- Hardware-backed owner approval
- On-chain/capability certificates in ZK public inputs (research only)

## Hardening

Closed experimentally:

1. **Owner-signed capability** (`agent-capability-cert.ts`): owner Ed25519 over capability body; forged `ownerId` without matching key fails.
2. **Signed ActionRequest before pay** (`agent-action-request.ts`): agent signs permission/amount/asset/service/nonce/sequence; authorize verifies sig first.
3. **Nonce/sequence window** (`agent-nonce.ts`): TTL prune + monotonic sequence anti-replay.

Still **not** integrated into PaymentRequest / SpendIntent / consensus.
