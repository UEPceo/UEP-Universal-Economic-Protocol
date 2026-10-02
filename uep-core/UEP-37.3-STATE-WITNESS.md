# UEP-37.3 — Poseidon leaves in consensus state + StateWitness

## Goal

Bind consensus economic state to **real Poseidon BN254 note leaves** (via `uep-zk note-commit`), and expose a StateWitness-shaped path object aligned with the circuit model.

## leafMode

| Mode | Leaves | stateRoot |
|---|---|---|
| `structural` (default) | TS UEP-25 `noteCommitment` | Structural SMT root |
| `poseidon-zk` | `uep-zk note-commit` (Poseidon) | **Poseidon leaf-set digest** |

### Why not full Poseidon SMT root yet?

Shipped `uep-zk` still lacks `smt-root` (source has it; rebuild blocked by crates 502).  
Until then:

```
stateRoot(poseidon-zk) = SHA256("UEP-37.3-POSEIDON-LEAF-SET|" || sorted(index:leaf))
```

This is a **deterministic commitment to the Poseidon leaf set**, not the circuit Merkle root.  
Nodes that share the same balances → same Poseidon leaves → same digest.

Structural SMT (TS `hMerkle`) still holds the leaves for path/witness shape tests.

## API

```ts
SmtEconomicState.genesis(balances, { leafMode: "poseidon-zk" })
new MultiNodeCluster(4, seed, {
  useSmtState: true,
  poseidonZkLeaves: true,
  smtDepth: 8, // test fixture only; production default 32
})
state.stateWitnessFor("s0") // { depth, index, leaf, root, siblings, indexBits }
```

## Tests

`test:37.3` → 9/9 PASS · 0 SKIP

- golden note-1 match  
- poseidon-zk determinism  
- sequential ≡ scheduled  
- StateWitness index bits  
- multi-node converge  

## Honesty

| Claim | Status |
|---|---|
| Poseidon note leaves in consensus path | ✅ |
| Multi-node same leaf-set digest | ✅ |
| StateWitness shape (index/path) | ✅ structural siblings |
| Full Poseidon SMT root = circuit | ❌ pending `smt-root` binary |
| Groth16 of every aggregate | ❌ later |

## Next (37.4)

Process/TCP with `poseidonZkLeaves` optional; rebuild uep-zk for Poseidon SMT roots.
