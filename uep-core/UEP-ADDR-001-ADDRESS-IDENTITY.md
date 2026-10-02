# UEP-ADDR-001 — Address & Identity Model

**Status:** 🟠 DESIGN SPEC (not implemented in wallet/circuit)  
**Date:** 2026-09-27  
**Depends on:** UEP-26 hash freeze, Poseidon BN254, domain tags 1–5  
**Does not change:** SpendCircuit, 12 public inputs, fee, D=32, Groth16  
**Intent:** Freeze the *address layer* before the wallet becomes user-facing, so we do not retrofit identities after adoption.

---

## 0. Non-goals (this revision)

- No centralized UEP DNS / single registry owned by the project.
- No global permanent username = permanent payment destination.
- No speculative token required to hold or resolve an address.
- No Directory implementation yet (Level 3 stays design-only).
- No change to on-circuit `recipient_id: Fr` encoding until ADDR is frozen and a migration note is written.

---

## 1. Two concepts (must not be mixed)

| Concept | What it is | What it is not |
|---|---|---|
| **Cryptographic address** | Where value can be sent / which SMT slot identity binds | A human name, email, or social handle |
| **Identity / alias** | How humans find each other (`@bob`, QR, contact) | The protocol’s economic identifier |

```
User intent ("pay @bob 25")
        │
        ▼
   Directory / Resolver   ← Level 3 (future, multi-provider)
        │
        ▼
   UEP Address record     ← Level 2 (wallet UX)
        │
        ▼
   address_id : Fr        ← Level 1 (protocol / SMT / circuit)
```

The SNARK and SMT **only** ever see Level 1 (`address_id` and related field elements).  
Levels 2–3 are wallet and network services.

---

## 2. Level 1 — `address_id` (protocol)

### 2.1 Domain tag reservation

Extend UEP-26 domain tags **without** reusing existing ones:

| Tag | Value | Status |
|---|---|---|
| `D_ACCOUNT` | 1 | Frozen (key → account id in circuit today) |
| `D_NULLIFIER` | 2 | Frozen |
| `D_MERKLE` | 3 | Frozen |
| `D_LEAF` | 4 | Frozen |
| `D_TX` | 5 | Frozen |
| **`D_ADDR`** | **6** | **Reserved by this spec** |
| `D_PAYMENT_REQ` | 7 | Reserved (payment request binding) |
| `D_DIR` | 8 | Reserved (directory record binding, future) |

Composition remains the frozen form:

```
H(domain, a, b) := Poseidon( Poseidon(Fr(domain), a), b )
```

### 2.2 Address key material

A receiving capability is derived from:

- `spend_secret` (wallet master; never leaves device)
- optional `view_secret` (scan / recover incoming notes; optional phase-2)
- `addr_index` (u32/u64 counter for rotating receive addresses)
- `domain_id` (Fr or fixed-width domain identifier — see §4)

**Recommended derivation (Poseidon-native):**

```
view_key     = H(D_ADDR, spend_secret, Fr(1))           // optional
addr_seed    = H(D_ADDR, spend_secret, Fr(2) + addr_index)  // or H_fold
address_id   = H(D_ADDR, domain_id, addr_seed)
```

Notes:

- `address_id` is a field element in BN254 Fr (same field as the circuit).
- It is **not** a raw public key and **not** `h_account(secret, salt)` reused blindly.
- Today’s lab `recipient_id` / `h_account` remains valid for **SpendCircuit experiments**; migration path is: map `address_id → recipient_id` once ADDR is implemented (see §11).

### 2.3 What goes into the SMT

```
address_id  →  lowBits(address_id, D)  →  leaf index
leaf        =  note_commitment(owner_id, asset_id, amount, blinding)
```

`owner_id` for notes should eventually be `address_id` (or a stable commitment to it), not a social alias.

### 2.4 Nullifiers and privacy

Nullifiers stay:

```
nullifier = H(D_NULLIFIER, spend_secret, note_nonce)
```

Rotating `address_id`s (many receive addresses per wallet) reduce linkability of **incoming** payments on a transparent or semi-transparent state view.  
They do **not** by themselves hide amounts if leaves/public data leak value; privacy of amounts remains a property of the ZK model already chosen (SpendCircuit public inputs still expose amount/fee — see §10).

---

## 3. Level 2 — Encoded address (wallet-facing)

### 3.1 Logical payload

An encoded address packages:

| Field | Purpose |
|---|---|
| `version` | Encoding version (start at 1) |
| `network_id` | Logical network profile (`dev` / `local` / `testnet` / future `main`) |
| `domain_id` | Economic state domain (Earth, Mars, orbit, custom — §4) |
| `addr_type` | See §3.2 |
| `address_id` | 32-byte Fr encoding (big-endian or canonical compact) |
| `checksum` | Integrity of the string form |

**Checksum (design choice for v1):**  
Bech32/Bech32m-style checksum over the human-readable prefix + data, **or** truncated Poseidon/SHA-256 of the binary payload. Prefer a widely debugged string checksum (Bech32m) for UX; cryptographic binding of the *id* remains Poseidon/`D_ADDR`.

### 3.2 Address types (`addr_type`)

| Code | Name | Meaning |
|---|---|---|
| 0 | `RECEIVE` | Standard one-time or rotating receive address |
| 1 | `STATIC` | Long-lived receive (discouraged for privacy-sensitive users) |
| 2 | `PAYMENT_REQ` | Not a pure address; points to a signed payment request blob |
| 3 | `CONTRACT` | Reserved: future non-EOA economic endpoint |
| 4–15 | — | Reserved |

### 3.3 String form (illustrative, not frozen UI)

```
uep1<source_hrp_parts>1<data+checksum>
```

Conceptual example (non-normative):

```
uep1d...7xK9...
```

**Human-readable part** should encode at least network class so that:

- a `dev` address cannot be pasted silently into a `testnet` / future production context;
- domain MAY appear in HRP or in the binary payload (payload is mandatory; HRP is UX).

**Rule:** Wallets MUST reject addresses whose `network_id` / `domain_id` do not match the active profile (aligns with UEP-29 DEV isolation).

### 3.4 Rotating receive addresses

Default wallet behaviour for “Receive 25”:

1. Allocate `addr_index++`.
2. Derive `address_id`.
3. Show encoded address + optional QR payment request (§5).
4. Do **not** reuse the same receive address for unrelated counterparties when privacy mode is on.

Static addresses are allowed for public organizations with explicit user consent and warnings.

---

## 4. `domain_id` (economic locality)

Research track requirement: value lives in a **domain**, not in a single implicit global tree forever.

```
user → address → domain_id → state SMT / nullifier SMT
```

### 4.1 Properties

- `domain_id` is a first-class field element (or fixed-width id mapped into Fr).
- An address is **domain-scoped**: the same `addr_seed` under two domains yields two `address_id`s.
- Cross-domain transfer is **not** a local spend; it is a future settlement/bridge protocol (out of scope for ADDR-001 implementation).

### 4.2 Examples (logical)

| Domain | Role |
|---|---|
| `earth` | Default terrestrial testnet/main |
| `mars` | Future high-latency domain |
| `orbit` | Relay / settlement buffer (conceptual) |
| private org domains | Enterprise isolation |

### 4.3 Relation to 12 public inputs

**Today:** `domain_id` is **not** among the 12 SpendCircuit public inputs.  
**ADDR-001 design requirement for a future circuit revision (not now):** bind `domain_id` (or `network_id || domain_id`) into `transaction_commitment` / public inputs so a proof cannot be replayed across domains.

Until that revision, wallets MUST still carry `domain_id` in the address and refuse cross-domain paste; consensus nodes MUST tag state by domain offline.

---

## 5. Payment requests & QR (Level 2)

A payment request is **not** only an address. Binary/QR payload SHOULD include:

| Field | Required |
|---|---|
| `version` | yes |
| `recipient_address` or `address_id` + domain | yes |
| `asset_id` | yes |
| `amount` | optional (open amount) |
| `expiry` | recommended |
| `memo` / `order_id` | optional |
| `merchant_sig` or request MAC under `D_PAYMENT_REQ` | recommended |

```
PaymentRequest
  → QR / deep link
  → wallet parses
  → builds SpendIntent + witness
  → Groth16 / engine
```

Expiry and amount binding reduce QR-swap and amount-tampering attacks at the UX layer (protocol still enforces conservation inside the circuit).

---

## 6. Level 3 — Naming / Directory (design only)

### 6.1 Aliases

```
@bob  →  Directory record  →  current receive address (or payment endpoint)
```

Aliases are **not** addresses. They MUST be resolvable to Level 2 records with:

- `address` or payment endpoint
- `domain_id`
- validity period
- cryptographic attestation (`D_DIR`)

### 6.2 No single UEP-owned DNS

Preferred model: **namespaces + multiple resolvers**

```
@bob.uep          resolver set A
@alice.bank       resolver set B
@company.energy   resolver set C
```

Resolvers may compete; clients verify **signed records**, not “whatever the project server said”.

### 6.3 Explicit non-goals for v1 naming

- No global auction for short names in-protocol.
- No requirement that every user buy a name.
- No identity-equals-payment-address.

---

## 7. Privacy summary

| Mechanism | Helps with |
|---|---|
| Rotating `address_id` | Linking of sequential receives to one static string |
| Separate view key (future) | Scan without spend authority |
| ZK SpendCircuit | Hiding secrets / paths; **amounts still public today** |
| Domain separation of hashes | Cross-protocol collision / transcript attacks |

**Honest limit (current circuit):** public inputs still include `amount`, `fee`, ids, roots. ADDR-001 does not claim full payment confidentiality. A future privacy upgrade is a separate circuit revision.

---

## 8. Recovery

| Secret | Role |
|---|---|
| BIP39 / SLIP-39 style mnemonic → `spend_secret` | Full control (design choice; encoding TBD) |
| `view_secret` only | Rescan receives (if implemented) |
| Social recovery | Out of scope for ADDR-001 |

Derivation of all `addr_index` receive addresses MUST be deterministic from `spend_secret` so recovery re-derives history.

---

## 9. Interplanetary / multi-domain readiness

Addresses are designed so that:

1. `domain_id` is explicit in Level 1–2.  
2. Nullifiers remain domain-local unless a future cross-domain nullifier set is defined.  
3. DTN / high latency is **transport**, not address format.  
4. No assumption of a single global clock in the address string.

This keeps ADDR compatible with Research Track conclusions without implementing interplanetary consensus now.

---

## 10. Compatibility with UEP-30 Execution Engine

| Engine field today | ADDR-001 mapping |
|---|---|
| `AccountState.id` / `recipient_id` | Becomes `address_id` once wallet emits ADDR |
| `bootstrapZeroNotes` | Seeds leaves for known `address_id`s |
| `network_profile` | Must match address `network_id` |
| `transitionId` | Unchanged (SHA-256 of 12 publics); future may fold domain |

**No engine change required to publish this spec.**

---

## 11. Migration note (when implementing)

1. Implement encode/decode + checksum in TS (no circuit change).  
2. Wallet generates rotating receive addresses; lab still maps to `Fr` recipient.  
3. Optional: add `domain_id` into `transaction_commitment` (circuit + public input policy) — **requires explicit pillar consultation**.  
4. Directory / resolvers last.

---

## 12. Acceptance criteria for “ADDR designed”

- [x] Address ≠ alias documented  
- [x] `D_ADDR` / `D_PAYMENT_REQ` / `D_DIR` reserved  
- [x] Domain-scoped derivation sketched  
- [x] Rotating receives recommended  
- [x] Payment request fields listed  
- [x] Multi-resolver directory stance  
- [x] No token requirement  
- [x] String encoding bytes frozen (UEP-ADDR-002 Bech32m)  
- [ ] Circuit binding of `domain_id` (future, opt-in)  
- [ ] Directory wire format (DIR-001)

---

## 13. Recommendation

**Freeze ADDR-001 as the design baseline for wallet UX.**  
**Do not implement Directory yet.**  
**Continue UEP-30.3 persistence** on the canonical engine; when the wallet leaves prototype mode, implement Level 2 encoding first, then Level 3 resolvers.

