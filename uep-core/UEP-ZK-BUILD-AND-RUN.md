# How to build and run `uep-zk`

`uep-zk` is the local lab tool for the UEP-26 spend circuit (Groth16 over BN254
with development keys). There is **no** production ceremony, and the keys it
generates are for testing only.

This repository **does not include any prebuilt binary**. Build it from source:

```bash
npm run build:uep-zk          # = scripts/build-uep-zk.sh
# resulting binary: uep-core/target/release/uep-zk
uep-core/target/release/uep-zk circuit-id
```

Requirements: stable Rust (CI uses 1.85.1) and access to crates.io. The
`Cargo.lock` of `uep-26-spend-circuit` is pinned (`cargo build --locked`).

The lab TypeScript code (`src/lab/zk-bridge.ts`, `src/lab/uep-zk-runner.ts`)
looks for the binary in this order: the `UEP_ZK_BIN` environment variable,
`uep-core/target/release/uep-zk`, then other local paths inside the repository
(there is no shared `/tmp` fallback). `npm run test:lab` (and therefore
`npm run test:all`) sets `UEP_ZK_BIN` automatically when the built binary exists.

## Smoke test

```bash
npm run smoke:zk        # D=4 demo: setup + prove + verify
```

## Scope

- Development Groth16 keys, generated locally. Do not use them outside the lab.
- Proofs are not yet part of the public testnet ledger (`src/testnet`). The
  ledger and the circuit share the same Poseidon BN254 hash, but the ledger uses
  a 254-bit SMT and key-derived account ids, while the circuit uses a 32-level
  tree and the older `H_ACCOUNT(secret, salt)` binding (see `docs/LABS.md`,
  "Differences between the labs and the public core").
