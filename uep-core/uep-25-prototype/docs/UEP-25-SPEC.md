# UEP-25 — Atomic Sparse-State Transition Specification

> Lab specification of the Rust reference state machine in `uep-core/uep-25-prototype`
> (tested by `npm run test:rust`). It is not the public testnet ledger, whose rules
> live in `src/core` and `src/testnet` (see `docs/LABS.md`).

## Objective

Close the architectural flaws found in UEP-23/24 and move the core towards a
verifiable prototype.

## Invariants

### Ownership

`SenderID = H_ACCOUNT(secret, salt)`

### Nullifier

`N = H_NULLIFIER(secret, nonce)`

The same `secret + nonce` cannot be accepted twice.

### Fee

`fee = max(1, floor(amount * 10 / 10000))` for `amount > 0` (`src/fee.rs`).

This is 0.1% in integer units, rounded down, with a 1-unit floor: the same rule
as the public core and the UEP-26 circuit (v3). Earlier revisions of this
specification used `floor(amount * 10 / 10000)` without the floor.

### Transfer

`sender_new = sender_old - amount - fee`

`recipient_new = recipient_old + amount`

`treasury_new = treasury_old + fee`

### Conservation

`sender_old + recipient_old + treasury_old`
=
`sender_new + recipient_new + treasury_new`

### State

Final acceptance requires:

`old_state_root -> new_state_root`

through three atomic SMT updates, and:

`old_nullifier_root -> new_nullifier_root`

through the insertion of the nullifier.

## Domains

Hashes are domain-separated for:

- accounts,
- nullifiers,
- leaves,
- Merkle nodes,
- transaction commitments.

This prevents the same hash relation from being reused by accident for
semantically different objects.

## Open items recorded by this specification

This list was written when UEP-25 was the most advanced prototype. Several items
have since been addressed in later labs (for example the Poseidon parameter
freeze in UEP-26 and the Groth16 spend circuit in `uep-26-spend-circuit`); none
of them makes the lab a production system.

1. Freeze the Poseidon/Poseidon2 parameters.
2. Implement the R1CS hash and SMT gadgets with those parameters.
3. Prove membership/update of the three leaves.
4. Prove nullifier insertion and non-replay inside the circuit.
5. Generate a real Groth16 proof and verify it against the set of public inputs.
6. Add canonical, versioned serialization.
7. Measure performance on defined hardware.
8. Add fuzzing and property-based testing.
9. Review overflow/range constraints inside the circuit itself.
10. Freeze the genesis/configuration ID of the network.
