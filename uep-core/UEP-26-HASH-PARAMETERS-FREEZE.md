# UEP-26 — Hash Parameter Freeze

**Status:** FROZEN for circuit design; vector suite PV-001…PV-009 materialised GOLDEN in UEP-26.5 (wallet live hash still UEP-25 placeholder)  
**Date:** 2026-09-23  
**Version:** UEP-26.2  

No parameters are invented. Everything below is taken from existing UEP-21 code or from the already-implemented wallet note model.

---

## 0. Poseidon vs Poseidon2 — contradiction resolved

| Statement | Status |
|---|---|
| UEP-26 production hash permutation | **Poseidon** (UEP-21) |
| Poseidon2 | **NOT used**. Different permutation. Requires a future protocol version if ever adopted. |
| Live wallet / Testnet hash today | UEP-25 algebraic placeholder (see §6). Migration to Poseidon is a coordinated step after vectors exist. |
| `Poseidon2Backend` in TypeScript / Android | Must throw / remain CONCEPTUAL. Never silently substituted. |

**Authoritative source of the Poseidon instance:**  
`uep-core/uep-21-poseidon/src/lib.rs` → `uep_poseidon_parameters()` / `uep_poseidon_hash(a, b)`.

---

## 1. Frozen permutation parameters

| Parameter | Value | Source |
|---|---|---|
| Field | BN254 scalar `Fr` (`ark_bn254::Fr`) | UEP-21 |
| Permutation | **Poseidon** (not Poseidon2) | UEP-21 |
| Width `t` | 3 | `setup_poseidon_params(Curve::Bn254, 5, 3)` |
| S-box `alpha` | 5 | same |
| Rate | 2 | width 3 = rate 2 + capacity 1 |
| Capacity | 1 | same |
| Full / partial rounds, MDS, round keys | Exactly the values returned by `arkworks_utils::poseidon_params::setup_poseidon_params(Curve::Bn254, 5, 3)` | Never hard-coded |

Two-input native hash:

```text
Poseidon2input(a, b)  :=  Poseidon_t3( [a, b] )   // existing uep_poseidon_hash
```

---

## 2. Frozen domain tags

| Domain | Tag (u64 → Fr) | Symbol |
|---|---|---|
| Account | 1 | `D_ACCOUNT` |
| Nullifier | 2 | `D_NULLIFIER` |
| MerkleNode | 3 | `D_MERKLE` |
| Leaf | 4 | `D_LEAF` |
| Transaction | 5 | `D_TX` |

These match the existing UEP-25 / TypeScript `Domain` enum and the UEP-26 circuit contract.

---

## 3. Frozen domain composition

All protocol hashes that require domain separation use **exactly** this composition (built only from the 2-input Poseidon API):

```text
H(domain, a, b)  :=  Poseidon2input( Poseidon2input( Fr(domain_tag), a ), b )
```

Equivalently in code:

```rust
fn domain_hash(domain: u64, a: Fr, b: Fr) -> Fr {
    let d = Fr::from(domain);
    let inner = uep_poseidon_hash(d, a);
    uep_poseidon_hash(inner, b)
}
```

Named helpers (normative):

```text
H_ACCOUNT(secret, salt)     = H(1, secret, salt)
H_NULLIFIER(secret, nonce)  = H(2, secret, nonce)
H_MERKLE(left, right)       = H(3, left, right)
H_LEAF(a, b)                = H(4, a, b)
H_TX(a, b)                  = H(5, a, b)
```

**Rationale:** Uses only the already-implemented 2-input Poseidon; injects the domain tag as a first input; is order-sensitive and domain-separating by construction.

---

## 4. Frozen leaf / note encoding

### 4.1 Empty leaf

```text
EMPTY_LEAF = Fr(0)
```

Depth of both account and nullifier SMTs: **32** (already used by UEP-25 / wallet).

### 4.2 Note commitment (wallet UTXO layer → circuit witness)

Already implemented in `src/core/note.ts` and mirrored conceptually in Android. Frozen as:

```text
amount_fr          = Fr(amount)                    // amount ∈ [0, 2^64)
inner_asset        = H_LEAF( asset_id, amount_fr )
payload            = H_LEAF( owner, inner_asset )
note_commitment    = H_LEAF( payload, blinding )
note_nonce         = H_LEAF( note_commitment, blinding )
```

### 4.3 Ownership and nullifier

```text
account_id / sender_id  = H_ACCOUNT( sender_secret, sender_salt )
nullifier               = H_NULLIFIER( sender_secret, note_nonce )
```

### 4.4 Nullifier leaf (for nullifier SMT insertion)

```text
nullifier_leaf = nullifier
```

(The public nullifier field element is the leaf value. Empty slot = `EMPTY_LEAF`.)

### 4.5 Account-balance state leaf (UEP-26 first version)

For the first circuit version the state SMT leaf for a single `(account_id, asset_id)` balance is:

```text
balance_fr     = Fr(balance)                       // balance ∈ [0, 2^64)
state_leaf     = H_LEAF( account_id, H_LEAF( asset_id, balance_fr ) )
```

Key used for path index: `account_id` (single-asset first version). Multi-asset packed leaves require a protocol version bump.

### 4.6 Transaction commitment

```text
tx_commitment = H_fold( D_TX, [ Fr(ENCODING_VERSION=1), ...canonical public parts ] )
```

where `H_fold` is left-fold of `H_TX`:

```text
H_fold(d, [x0])       = x0
H_fold(d, [x0,...,xk]) = H(d, H_fold(d, [x0,...,x{k-1}]), xk)
```

(Exact public-part list remains as in the circuit contract public inputs order.)

---

## 5. Deterministic Poseidon test vectors

### 5.1 Canonical field encoding

Every field element serialized outside the arithmetic circuit is encoded as exactly 32 bytes, unsigned, canonical BN254 Fr, **big-endian**, with no prefix. The TypeScript `Fr.toHex()` / `toBytesBE()` representation is normative for UEP object serialization.

### 5.2 Deterministic Poseidon test vectors

The committed fixture is:
`uep-core/uep-21-poseidon/vectors/UEP-26-POSEIDON-VECTORS.json`

The cross-implementation golden vector PV-001 is:
`Poseidon([1,2]) = 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a`

The remaining deterministic fixtures are generated by the same reference implementation and must be materialized into the JSON fixture before UEP-26 can become production-ready.

Generation command:

```bash
cd uep-core/uep-21-poseidon
cargo test print_uep26_poseidon_vectors -- --nocapture
```

The test (added in this revision) prints hex encodings of:

| Vector ID | Inputs | Expected output |
|---|---|---|
| PV-001 … PV-009 | See `uep-21-poseidon/vectors/UEP-26-POSEIDON-VECTORS.json` | **GOLDEN** (UEP-26.5) |

Until the generator has been run successfully and the printed values committed, the Poseidon output column is **not** normative. The *inputs and composition formulas* are frozen.

### 5.3 Live wallet vectors (UEP-25 algebraic — already tested)

These remain the normative vectors for the **currently running** TypeScript / Android algebraic backend. They must keep passing:

| Domain | a | b | h |
|---|---|---|---|
| Account | 1 | 2 | 32 |
| Nullifier | 1 | 2 | 63 |
| MerkleNode | 1 | 2 | 104 |
| Leaf | 1 | 2 | 155 |
| Transaction | 1 | 2 | 216 |
| Account | 7 | 11 | 497 |
| Nullifier | 7 | 9 | 501 |

Source: `src/core/uep.test.ts` and UEP-25 `hash.rs`. These are **not** Poseidon outputs.

---

## 6. Migration rule

1. Wallet and Testnet continue to use the UEP-25 algebraic hash until an explicit migration release.
2. UEP-26 circuit design and future gadgets use the Poseidon composition defined in §3–§4.
3. No production Groth16 proving/verification key may be generated until:
   - the Poseidon vectors in §5.1 have been generated and committed, and
   - this freeze document is marked production-ready by a later history entry.

---

## 7. Explicitly out of scope (this freeze)

- SMT membership / direction-bit R1CS gadgets
- Full SpendCircuit assembly
- Groth16 setup / keys
- Poseidon2
- Changing fee policy or public-input order

---

## Traceability

- UEP-21 implementation: `uep-core/uep-21-poseidon/`
- Circuit contract: `uep-core/UEP-26-SPEND-CIRCUIT-SPEC.md`
- Note model: `src/core/note.ts`
- History: `UEP-26-HISTORY.md` entry UEP-26.2
