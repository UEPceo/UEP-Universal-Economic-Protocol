# UEP-37.1 — Leaf Encoding Freeze + Honest Poseidon Status

## Why this version exists

37.0 put an SMT on the consensus path, but:

- leaves used a simplified `H_LEAF(H_LEAF(id, asset), amount)` (missing blinding nest order of the circuit)
- depth 16 could be confused with production D=32
- hash backend was still UEP-25 placeholder while labeled “Poseidon path”
- nullifiers were absent from consensus state

37.1 closes those gaps **without** claiming bit-identical Poseidon roots in pure TypeScript.

## Frozen leaf formula (matches `hash_gadget.rs`)

```
note_commitment(owner, asset, amount, blinding) =
  H_LEAF(
    H_LEAF(owner, H_LEAF(asset, amount)),
    blinding
  )
```

```
note_nonce(commitment, blinding) = H_LEAF(commitment, blinding)
nullifier(secret, nonce)         = H_NULLIFIER(secret, nonce)
index(owner)                     = lowBits(owner, DEPTH)
```

Canonical **DEPTH = 32**.

`TEST_ONLY_SMT_DEPTH = 16` is allowed only with `isTestFixture: true`.

## Hash backend honesty

| Layer | Permutation |
|---|---|
| SpendCircuit / uep-zk / Rust | Poseidon BN254 t=3 α=5 |
| TypeScript default | UEP-25 algebraic placeholder |

`leafEncodingMeta().poseidonBitIdentical === false` until a Poseidon TS backend is activated or roots are verified via `uep-zk`.

**Do not say “Poseidon integrated in consensus” until a golden vector matches TS↔Rust bit-for-bit.**

## Nullifiers

`SmtEconomicState` maintains a parallel nullifier SMT:

- insert rejects duplicates
- `nullifierRoot` / `previousNullifierRoot` tracked per height

Lab transfers may omit nullifiers; ZK spends must supply them.

## State transition binding (current)

```
previousRoot  →  applyTransfers (+ optional nullifiers)  →  newRoot
```

Consensus still binds roots via proposal digest + vote-time preview.

**Not yet:** full StateWitness / Groth16 proof of every consensus aggregate transition.

## Exit criterion for later 37.x

Golden vector (Poseidon):

```
owner, asset, amount, blinding
→ leaf
→ SMT root_old
→ transfer
→ root_new
```

identical in:

1. TypeScript (Poseidon backend or uep-zk RPC)
2. Rust `UepPoseidon`
3. SpendCircuit public inputs

## Process/TCP

Deferred until 37.2+ golden / witness alignment.

## Tests

- `test:37.1` — encoding, depth policy, nullifiers, D=32 multi-node
- `test:37` — includes 37.0 regression fixtures
