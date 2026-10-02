# UEP-26 — ZK Spend Circuit Specification

Status: **SPECIFICATION / CANDIDATE — NOT PRODUCTION-FINAL**
Version: UEP-26.4

Errata applied 2026-09-24: Poseidon (not Poseidon2), domain composition, and leaf encoding are frozen by UEP-26.2+; production proving/verification is still not complete.

## 1. Purpose

UEP-26 defines the statement a spend proof must establish without revealing the sender's secret witness.

The circuit must prove that a transaction is a valid state transition over the canonical UEP state and nullifier trees.

A proof is **not** a balance statement alone. It must bind ownership, note membership, nullifier derivation, fee policy, conservation, transaction commitment and the old/new state roots.

## 2. Cryptographic boundary

The following must be frozen before a production proving/verification key is generated:

- BN254 scalar field `Fr` (candidate backend)
- exact Poseidon permutation and parameter set — **FROZEN; Poseidon2 excluded**
- byte/field canonical encoding — **field/circuit encoding frozen; remaining transport serialization is separate**
- domain separators — **FROZEN**
- SMT depth and empty-node values — **FROZEN for the current design**
- leaf encoding — **FROZEN in UEP-26.2**
- transaction encoding — **contracted; production serialization remains versioned work**
- proof system and version — **not production-final**

This document is the current UEP-26 circuit contract. It is not a production verification-key specification until the remaining implementation and vector gates are complete.

## 3. Public inputs

Canonical order:

1. `old_state_root`
2. `new_state_root`
3. `old_nullifier_root`
4. `new_nullifier_root`
5. `sender_id`
6. `recipient_id`
7. `treasury_id`
8. `asset_id`
9. `amount`
10. `fee`
11. `nullifier`
12. `transaction_commitment`

All public inputs are field elements after canonical encoding.

## 4. Private witness

- `sender_secret`
- `sender_salt`
- `note_nonce`
- `sender_old_amount`
- `sender_new_amount`
- `recipient_old_amount`
- `recipient_new_amount`
- `treasury_old_amount`
- `treasury_new_amount`
- `sender_old_leaf`
- `sender_new_leaf`
- `recipient_old_leaf`
- `recipient_new_leaf`
- `treasury_old_leaf`
- `treasury_new_leaf`
- sender Merkle siblings + direction bits
- recipient Merkle siblings + direction bits
- treasury Merkle siblings + direction bits
- nullifier Merkle siblings + direction bits

For the first implementation, the state leaf represents one `(account_id, asset_id)` balance. A later multi-asset packed-leaf design must not silently change the circuit contract; it requires a versioned protocol change.

## 5. Account ownership

Constraint:

`sender_id = H_ACCOUNT(sender_secret, sender_salt)`

The account hash must use a dedicated domain separator and the frozen protocol hash.

The recipient and treasury IDs are public. No recipient secret is required for a transfer to an existing account.

## 6. Note / leaf commitment

The sender old leaf must bind at least:

`H_LEAF(sender_id, asset_id, sender_old_amount, note_nonce, leaf_blinding)`

The leaf encoding is frozen for UEP-26.2+ as follows:

`amount_fr = Fr(amount)`
`inner_asset = H_LEAF(asset_id, amount_fr)`
`payload = H_LEAF(owner, inner_asset)`
`note_commitment = H_LEAF(payload, blinding)`
`note_nonce = H_LEAF(note_commitment, blinding)`

The production circuit is still not final because the cryptographic implementation/vector gates are incomplete.

The sender old leaf must be proven as a member of `old_state_root`.

The sender new leaf must be proven as the corresponding updated leaf in `new_state_root`.

The same applies to recipient and treasury leaves.

## 7. Merkle membership and update

For every updated account:

`Merkle(old_leaf, path) = old_state_root`

`Merkle(new_leaf, same_path) = new_state_root`

The circuit must bind the path direction bits to the leaf key/index. Direction bits must not be freely selectable by a prover.

The three updates are:

1. sender
2. recipient
3. treasury

The circuit must prove that all three updates belong to the same old/new state roots.

## 8. Nullifier

Constraint:

`nullifier = H_NULLIFIER(sender_secret, note_nonce)`

The nullifier is public.

The nullifier tree transition must prove:

`Merkle(empty_leaf, nullifier_path) = old_nullifier_root`

`Merkle(nullifier_leaf, nullifier_path) = new_nullifier_root`

`nullifier_leaf` must be the canonical encoding of the public nullifier.

This proves insertion at an unused position, subject to the final frozen SMT encoding.

## 9. Fee

Current protocol policy:

`fee = floor(amount / 1000)` (equivalently `floor(amount * 10 / 10000)`)

The circuit must not rely on field arithmetic alone because modular arithmetic could otherwise permit wraparound.

Recommended implementation:

- decompose `amount` into 64 bits;
- prove `amount` is within the protocol's integer range;
- compute the integer fee with a quotient/remainder relation;
- enforce `fee * 1000 + remainder = amount`;
- enforce `0 <= remainder < 1000`.

If the protocol later changes the fee policy, this becomes a new circuit/protocol version.

## 10. Balance transition

For the sender:

`sender_old_amount = sender_new_amount + amount + fee`

For the recipient:

`recipient_new_amount = recipient_old_amount + amount`

For the treasury:

`treasury_new_amount = treasury_old_amount + fee`

All three balances must be range-constrained to the protocol integer width.

## 11. Conservation

For the affected asset:

`sender_old + recipient_old + treasury_old = sender_new + recipient_new + treasury_new`

The circuit must enforce the relation directly rather than trusting an external calculator.

## 12. Transaction commitment

The public `transaction_commitment` must bind every economically relevant field.

**Canonical fold (normative, matches `tx_commitment` / circuit):**

```text
tx_commitment = H_fold(D_TX, [
  ENCODING_VERSION=1,
  old_state_root,
  new_state_root,
  old_nullifier_root,
  new_nullifier_root,
  sender_id,
  recipient_id,
  treasury_id,
  asset_id,
  amount,
  fee,
  nullifier
])
```

`H_fold` is left-fold of `H_TX` / domain-hash under `D_TX` (single element returns itself).

Canonical serialization is mandatory. No field may be omitted because it is considered derivable outside the circuit.

## 13. Anti-replay

The nullifier is the replay protection primitive.

A second transaction using the same `(sender_secret, note_nonce)` must derive the same nullifier and therefore fail insertion into an already-spent position.

## 14. Constraint groups

The implementation must expose tests for these groups:

### C1 — Ownership
- correct secret accepted
- wrong secret rejected
- wrong salt rejected

### C2 — Nullifier
- correct derivation accepted
- wrong nonce rejected
- altered public nullifier rejected

### C3 — Merkle
- valid sender path accepted
- altered sibling rejected
- altered direction bit rejected
- wrong root rejected
- sender/recipient path cross-use rejected

### C4 — Fee
- exact fee accepted
- fee +1 rejected
- fee -1 rejected
- malformed quotient/remainder rejected
- overflow/wraparound rejected

### C5 — Amount
- zero rejected if zero-value transfers are disallowed
- maximum allowed amount accepted
- amount above range rejected
- modular-wraparound witness rejected

### C6 — State transition
- sender equation enforced
- recipient equation enforced
- treasury equation enforced
- old/new root binding enforced

### C7 — Transaction commitment
- every economically relevant field is bound
- changing any bound field invalidates the proof

### C8 — Nullifier insertion
- empty old leaf accepted
- already-used old leaf rejected
- wrong new leaf rejected

## 15. Public input ordering

The ordering in section 3 is consensus-critical. It must be identical in:

- circuit
- proving API
- verification API
- serialized proof envelope
- test vectors
- wallet/node implementations

## 16. Failure policy

No production API may emit a fake ZK proof.

Until a real proving backend exists, the implementation must return an explicit `NotImplemented`/`Unsupported` status rather than a successful proof object.

## 17. Definition of done for UEP-26

UEP-26 is complete only when:

1. hash parameters are frozen;
2. leaf encoding is frozen;
3. SMT gadget is implemented inside R1CS;
4. all arithmetic is range-safe;
5. all C1-C8 tests exist;
6. positive and negative vectors are published;
7. constraint count is measured;
8. deterministic witness generation exists;
9. the same vectors pass independently in Rust and the wallet integration layer;
10. only then is Groth16 setup allowed for UEP-27.
