# UEP-37.4 — Poseidon SMT Root (COMPLETED)

## Acceptance

| Criterion | Status |
|---|---|
| stateRoot from real Poseidon SMT | ✅ `uep-zk smt-root` |
| TS consensus root === Rust root bit-for-bit | ✅ |
| StateWitness via `smt-path` | ✅ |
| Golden cross-stack | ✅ `vectors/UEP-37.4-POSEIDON-SMT-GOLDEN.json` |
| No silent fallback to leaf-set digest | ✅ |
| Process/TCP | **not** in this version |

## Rebuild

Build from source with:

```bash
npm run build:uep-zk   # uep-core/target/release/uep-zk
```

The binary hash depends on the toolchain and platform; it is not pinned.

## CLI authority

```
note-commit  → Poseidon leaf
low-bits     → index
smt-root     → Poseidon SMT root (empty or with index:leaf…)
smt-path     → siblings + index_bits + root
h-merkle     → single internal node
```

Canonical depth production: **32**. Fixtures may use 8.

## stateRoot (poseidon-zk)

```
leaves = note_commitment_Poseidon(owner, asset, amount, blinding)
index  = lowBits(owner, D)
stateRoot = PoseidonSmt.root( leaves )   // via uep-zk smt-root
```

## Sample golden (D=8)

| Item | Value |
|---|---|
| empty root | `264211bfc6d88522689c87af087b106952a090e0b529f412728829071789f1a4` |
| note-1 leaf | `0011b463d4a14a5faffe6f527eb73480200273eef065440bf37acb12f221daf0` |
| after insert idx=42 | `0e0775b95cc1efd3077548b672e7957dd26138424726d0a7f3dd84b9687ac323` |

## Tests

`test:37.4` → **12/12 PASS**  
`test:37.2`+`37.3`+`37.4` → **29/29 PASS**

## Next

**UEP-37.5 — Process/TCP** on this canonical Poseidon `stateRoot`.
