# Public Architecture

## Layering

```text
┌──────────────────────────────────────────────┐
│              UEP DIGITAL MARKETPLACE         │
│ listings · orders · HOLD · delivery · fees  │
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
- note commitments;
- a Sparse Merkle representation of account/asset state;
- a nullifier set;
- accepted transactions;
- pending/conflicting transactions;
- deterministic snapshots.

## Cryptographic boundary

The public release uses deterministic field/hash/commitment primitives and the
reference development spend-MAC path. It deliberately does not publish a claim that
the public repository contains a production Groth16/Nova deployment.

## Treasury boundary

Two concepts must not be confused:

1. **UEP testnet protocol treasury** — used by the reference transaction fee rule.
2. **Marketplace Treasury** — business-layer accounting for the 3% Marketplace fee.

The Marketplace Treasury is not a native UEP token treasury.
