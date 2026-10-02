# Public Architecture

## Layering

```text
┌──────────────────────────────────────────────┐
│           UEP DIGITAL MARKETPLACE            │
│ listings · orders · HOLD · delivery · fees   │
│ treasury · reputation · paymaster accounting │
└───────────────────────┬──────────────────────┘
                        │
                        │ business-layer boundary
                        ▼
┌──────────────────────────────────────────────┐
│                 UEP TESTNET                  │
│ identities · notes · transactions · SMT      │
│ nullifiers · fees · local state transition   │
└──────────────────────────────────────────────┘
```

## Why the layers are separate

The Marketplace is a business application. UEP core is an economic state-transition
reference implementation. Keeping the boundary explicit prevents the public release
from implying that a marketplace order automatically becomes a consensus-finalized
protocol transaction.

## Public testnet state

The testnet maintains:

- balances keyed by account + asset;
- note commitments, in an append-only note-commitment Merkle tree (depth 32) whose root and size are part of snapshots; spends carry a membership proof;
- key-derived account ids (v0.4.5, UEP-ADDR-002): every note owner commits to an Ed25519 spend key, and every spend reveals the key and signs it (no key registry); addresses are Bech32m v2 strings (version, network tag, key hash);
- a Sparse Merkle representation of account/asset state;
- a nullifier set;
- accepted transactions;
- pending/conflicting transactions (validated at entry and on restore, bounded by `maxPendingTransactions`);
- deterministic snapshots, signed by Ed25519 snapshot authorities (optional k-of-n), hash-chained (`prevSnapshotHash`), with faucet mints signed by a separate faucet key.

## Cryptographic boundary

The public release uses deterministic field/hash/commitment primitives and the
reference development spend-MAC path, plus Ed25519 (`node:crypto`) signatures for
sender spend keys, snapshots, mints, Marketplace actions and IoT telemetry. It deliberately does not publish a claim that
the public repository contains a production Groth16/Nova deployment.

## Treasury boundary

Two concepts must not be confused:

1. **UEP testnet protocol treasury** — used by the reference transaction fee rule.
2. **Marketplace Treasury** — business-layer accounting for the 3% Marketplace fee (minimum 1 unit per settled order; the 0.1% protocol fee also has a 1-unit minimum).

The Marketplace Treasury is not a native UEP token treasury.
