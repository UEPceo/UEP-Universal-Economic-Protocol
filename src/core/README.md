# Core primitives (`src/core`)

| Field | Value |
|---|---|
| Status | Implemented (testnet) |
| Since | 0.3.0 |
| Tests | npm run test:protocol (core tests and RFC test vectors), npm run lint:determinism |
| Depends on | nothing outside src/core |

## Purpose

Poseidon BN254 hash, field arithmetic, sparse Merkle trees, notes, nullifiers, transactions (1 to 8 inputs since v0.5.3, ADR 0004), fee rule, asset ids and the signed asset registry manifest, Ed25519 wrappers, heights, domain profiles, RFC 9162 Merkle (inclusion and consistency proofs) and the zk-tx adapter (`zk-tx-adapter.ts`).

## Notes

- Transition code must be deterministic: no wall clock, randomness or network (ADR 0002, `npm run lint:determinism`).
- The development MAC and development ZK keys are test-only.

Full module map: [`docs/MODULES.md`](../../docs/MODULES.md).
