# UEP-22 — Final Poseidon/R1CS + Treasury Fee

## What changed

The previous provisional construction has been removed.

There is now NO `native_digest -> constant` shortcut in the circuit.

The circuit executes:

`FpVar(treasury_id), FpVar(fee) -> PoseidonGadget::hash -> public commitment`

inside R1CS.

## Parameter decision

UEP-22 fixes the first reference hash to:

- BN254 scalar field Fr
- Poseidon
- width t=3
- S-box x^5
- Circom-compatible parameter family
- binary 2-to-1 compression

Poseidon2 is intentionally a separate future backend and is not mixed with this
parameter set.

## Treasury rule

`fee * 10_000 = amount * 10`

Therefore the protocol fee is 0.1%.

The fee is linked to:

`TreasuryCommitment = Poseidon(TreasuryID, fee)`

## Attack tests

- wrong digest -> R1CS unsatisfied
- fee 99 for amount 100000 -> R1CS unsatisfied
- correct fee 100 -> R1CS satisfied
- tampered Groth16 public commitment -> verification fails

## Reproducibility

Run on a Rust toolchain compatible with the pinned Arkworks stack:

```bash
cargo test
cargo test --release
```

## Important

This environment does not expose cargo/rustc, so the assistant has NOT claimed
that these tests were compiled here. The code is deliberately pinned to the
Arkworks API generation used by the published PoseidonGadget reference.

The first external CI run should verify dependency resolution and then freeze
the Cargo.lock file.

## Canonical cross-vector

The Circom-compatible BN254 Poseidon ecosystem documents:

`Poseidon([1,2]) =
0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a`

UEP CI should assert this exact value before accepting the implementation.


## UEP-23 state transition

UEP-23 integrates UEP-22 into a Sparse Merkle state transition:

`old_root -> sender leaf update -> new_root`

while simultaneously proving:

- sender membership under `old_root`;
- balance conservation;
- exact integer 0.1% fee (`floor(amount/1000)`);
- Poseidon treasury commitment;
- Poseidon nullifier;
- sender membership under `new_root`.

Arkworks documents an R1CS Sparse Merkle implementation and a Poseidon gadget;
the native tree documentation uses Poseidon width 3 over BN254 and exposes
membership paths. See the project notes for the remaining production-hardening step: atomic sender+treasury update.

### Important

This is an architecture/circuit integration milestone, not a claim of a
production-audited protocol. `cargo test` has not been run in this environment
because Rust tooling is unavailable here.

> **Repository note:** this crate is a historical scaffold. It does not compile
> against the pinned arkworks API and is not part of `npm run test:rust`.
