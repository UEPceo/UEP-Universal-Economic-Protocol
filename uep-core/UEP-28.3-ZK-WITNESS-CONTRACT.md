# UEP-28.3 — ZK spend witness contract

## Purpose

Define the **exact** private witness the wallet must assemble so it matches
Rust `SpendCircuit<D>` before any `ZkSpendProofProvider` is activated.

## Public inputs (12) — already aligned in UEP-28.1

See `SPEND_PUBLIC_INPUT_NAMES` / Rust `public_inputs_from_circuit`.

## Private witness

| Group | Fields |
|---|---|
| Ownership | `senderSecret`, `senderSalt`, `noteBlinding`, `noteNonce` |
| Balances | old/new for sender, recipient, treasury |
| Intermediate roots | `midRootAfterSender`, `midRootAfterRecipient` |
| Paths (×4) | index, indexBits[D], siblings[D] — sender, recipient, treasury, nullifier |
| Leaves | old/new account leaves + nullifier leaf |
| Flag | `usePoseidon` |

## API

- `buildStructuralZkSpendInstance` — UEP-25 hash, sequential SMT replay
- `validateZkSpendInstance({ checkTrees })` — conservation + optional path checks
- `serializeZkSpendInstance` — hex JSON for FFI / Rust

## Explicit non-claims

- Does **not** generate Groth16 proofs from the wallet yet.
- Poseidon witness material still comes from Rust (`uep-zk`) until a Poseidon TS port exists.
- Production depth remains **32**.

## Tests

`src/core/zk-witness-contract.test.ts`
