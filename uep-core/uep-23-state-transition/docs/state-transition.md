# UEP-23 — State Transition Integration

## Goal

UEP-23 composes the UEP-22 Poseidon/R1CS fee circuit with a Sparse Merkle
state transition.

The proof statement is:

```text
old_root
   │
   ├── membership(account_id, old_balance, path)
   │
   ├── conservation:
   │      old_balance = new_balance + amount + fee
   │
   ├── fee:
   │      amount = 1000 * fee + remainder
   │      0 <= remainder < 1000
   │
   ├── nullifier:
   │      nullifier = Poseidon(secret, nonce)
   │
   ├── treasury commitment:
   │      treasury_commitment = Poseidon(UEP_TREASURY_DOMAIN, fee)
   │
   └── replace sender leaf
             │
             ▼
          new_root
```

## Why the fee is `floor(amount / 1000)`

0.1% = 10 / 10,000 = 1 / 1,000.

A field division is not an acceptable definition of an integer economic
quantity. UEP therefore uses:

`amount = 1000 * fee + remainder`

with:

`0 <= remainder < 1000`.

This gives exact floor semantics.

## Critical state-model decision

A single SMT leaf update cannot atomically move value from the sender leaf to
the treasury leaf. UEP-23 therefore makes the treasury commitment a public
effect and leaves treasury crediting to the next accumulator transition.

The production design should eventually use either:

1. a two-leaf atomic batch circuit (sender + treasury), or
2. a dedicated protocol-fee accumulator root.

Option 2 is preferable for very high-throughput operation because every
transaction then updates only the sender state while the fee accumulator is
folded recursively.

## Nullifier uniqueness

The circuit proves the nullifier is correctly derived. It does NOT by itself
prove global uniqueness across all history.

The network must reject a proof whose nullifier already exists in the global
Nullifier Set/SMT. This is a state-consensus rule, not a property that a single
Groth16 proof can establish in isolation.

## Path

For each of the 32 levels:

`bit=0 => (current, sibling)`
`bit=1 => (sibling, current)`

and:

`parent = Poseidon(left, right)`.

Arkworks publishes both native Sparse Merkle Tree support and R1CS constraints
for Sparse Merkle Trees, and its native implementation explicitly uses
Poseidon width 3 with zero padding for a two-input hash.

## Security requirement

Economic quantities MUST be range constrained to their intended integer width.
Without this, BN254 field arithmetic can wrap modulo the field prime.

The circuit allocates `amount`, `fee`, `remainder`, `old_balance` and
`new_balance` as canonical `UInt64` R1CS values and converts them to field
elements only for the Poseidon/field equations. `remainder < 1000` is also
constrained. This closes the previously identified field-wraparound hole.

## Atomicity roadmap

UEP-23a: one-leaf sender transition + fee commitment.

UEP-23b: two-leaf atomic sender/treasury transition.

UEP-23c: recursive Nova folding of UEP-23b.

UEP-23d: Groth16 final decider.

UEP-23e: nullifier SMT inclusion/non-inclusion transition.
