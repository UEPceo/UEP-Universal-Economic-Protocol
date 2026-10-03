# UEP-28.11 — Canonical Poseidon state, StateWitness, DEV isolation, Ledger Lab

## Closed in this revision

### 1. Canonical Poseidon state (P1)

| Element | Definition |
|---|---|
| Depth | D ∈ {4, 32}; production target **32** |
| Index | `lowBits(key, D)` |
| Empty leaf | `Fr(0)` |
| Node hash | Poseidon `H_MERKLE(left, right)` |
| Root | level D, index 0 |
| Balance leaf | `note_commitment(owner, asset, amount, blinding)` |
| Nullifier leaf | nullifier value at `lowBits(nullifier, D)` |

**Determinism:** same set of `(index, leaf)` → same root (order-independent; last-write-wins per index).

Module: `canonical_state.rs` (`build_state_from_leaves`, `StateWitness`).

### 2. StateWitness (P2)

```text
index, leaf, root, siblings[D], index_bits[D]
verify: bits match index LSB-first; recompute root == claimed root
```

Canonical path for proving without shipping the full tree.  
`extra_state_leaves` remains a **fixture/compat** way to seed multi-leaf state in `prove-spend-json`.

### 3. Nullifier SMT (P3)

- Seed with `existing_nullifiers`
- Reject if slot non-empty with a **different** value
- Insert → `new_nullifier_root`

### 4. Transaction commitment (P4) — no dualism on ZK path

**ZK-canonical** (SpendCircuit / Groth16 public input 11):

```
tx_commitment = H_TX(
  ENCODING_VERSION=1,
  old_state_root, new_state_root,
  old_nullifier_root, new_nullifier_root,
  sender_id, recipient_id, treasury_id, asset_id,
  amount, fee, nullifier
)
```

**Legacy MAC path** keeps UEP-25 `computeTxCommitment(network + notes)` — **not** interchangeable with ZK commitment.

**Network binding:** `network_profile` is carried in the request and labeled on artifacts (`keys=DEV-TEST-KEYS`). Full binding of `networkId` **inside** the circuit fold is **not** yet done (would change the 12-input schema / constraint count — requires explicit version bump). Cross-network proof reuse is mitigated at the **node profile layer** until a circuit version adds domain/network into the fold.

### 5. DEV isolation (P2 of roadmap)

| Profile | Test keys | Ceremony VK |
|---|---|---|
| `dev` | allowed | no |
| `local` (lab) | allowed | no |
| `testnet` | tagged DEV until ceremony | required later |

Artifacts print `keys=DEV-TEST-KEYS`. Mixing DEV proofs into a profile that forbids test keys must fail (`network_profile::assert_profile_compatible`).

### 6. Poseidon Ledger Lab (P3 of roadmap)

`src/lab/poseidon-ledger-lab.ts` — orchestrates:

```
economic fields → prove-spend-json → 12 publics → verify → transition record
```

`transitionId` = fingerprint of the **12 public inputs** (economic identity), not proof bytes → basis for idempotency (P5 roadmap).

### 7. Conflicts — min(TxID) (P6)

**Status: DEPRECATED as final rule.**

`min(TxID)` is **grindable** (adversary can grind commitments/nullifiers).  

Local domain rules going forward:

| Conflict | Resolution |
|---|---|
| Same nullifier twice | Second rejected (nullifier SMT) |
| Same economic transition, two proofs | Same `transitionId` → idempotent accept once |
| Competing spends different nullifiers same notes | Ownership / note spent flag; first accepted by sequence |
| Cross-domain double spend | **Not solved** — requires domain model (spec-only, P6 research) |

### 8. Time model (P7) — local only

Do **not** assume global clock for validity.

Local abstractions:

- `local_epoch` / sequence number per domain
- causal ancestry of state roots (`old → new`)
- validity interval optional off-circuit policy

Timeouts are **policy**, not cryptographic failure proofs.

### 9. Multi-domain / interplanetary

**Not implemented.** DTN = transport only. No global interplanetary state root.

## Tests

| Test | Status |
|---|---|
| `canonical_state` Rust unit tests | 🟡 requires `cargo test` |
| `prove-spend-json` D=4 | 🟡 requires `uep-zk` binary |
| `prove-spend-json` D=32 | 🟡 requires binary + high RAM/time |
| TS lab harness shape | 🟢 without binary |

## Explicit non-claims

- Android production ZK: 🔴
- P2P: 🔴
- Ceremony: 🔴
- Global domain finality: 🔴


> **SUPERSEDED (historical):** D=4/D=32 binary and cargo status were closed in **UEP-29.4** (0 SKIP, real Groth16, uep-zk hash `1feac898…`). Do not treat yellow binary flags in this file as current.
