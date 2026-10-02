# UEP-21 — Real Poseidon BN254 + R1CS gadget

This revision removes the experimental hand-written hash from UEP-20.

## Canonical choice

UEP-21 fixes **Poseidon over BN254 Fr**, width `t=3`, alpha `5`, using the
Arkworks/Webb parameter/gadget architecture and Circom-compatible parameter
construction.

The circuit uses the same native Poseidon instance to calculate the expected
public digest and the R1CS `PoseidonGadget` to constrain the in-circuit result.

## UEP primitives

- `uep_poseidon_hash(a,b)` — canonical 2-input hash
- `state_commitment(balance,ruleset,policy)`
- `state_nullifier(secret,state_root,amount)`
- `merkle_parent(left,right)`
- `PoseidonHashCircuit` — R1CS relation `Poseidon(a,b) == public_digest`

## Poseidon2

Poseidon2 is NOT silently substituted into this circuit. It has a different
permutation/parameter set and must have its own native implementation and R1CS
gadget. The backend trait is reserved for that future implementation.

## Validation

The test suite checks:

1. deterministic native hashing;
2. input/order sensitivity;
3. native/R1CS equality;
4. rejection of a wrong digest;
5. Groth16 proof/verification round-trip;
6. commitment and nullifier binding.

The current execution environment does not contain Rust/Cargo, so compilation
has not been falsely claimed. Run `cargo test` on a Rust toolchain to validate
against the resolved dependency graph.
