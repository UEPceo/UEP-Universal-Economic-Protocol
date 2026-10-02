# UEP-37.0 — SMT Economic State on Consensus Path

## Goal

Replace SHA-256 lab `stateRoot` with a **Sparse Merkle Tree root** over account balance leaves, so consensus proposals bind to a Merkle commitment compatible with the UEP SMT model (depth configurable; production target D=32).

## What changed

| Before (36.x default) | After (37.0 optional) |
|---|---|
| `LocalEconomicState.stateRoot()` = SHA256(balances\|height) | `SmtEconomicState.stateRoot()` = SMT.root() hex |
| Not Merkle | `SparseMerkleTree` + `hLeaf` / `hMerkle` |

## API

```ts
new MultiNodeCluster(4, seed, { useSmtState: true, smtDepth: 16 | 32 })
```

Default remains **LocalEconomicState** (no break of 36.x tests).

## Leaf encoding (structural LAB)

```
accountId = Fr(SHA256("UEP-37-ACCT|" || label)[0..31])
leaf = H_LEAF( H_LEAF(accountId, assetId=1), amount )
```

Not full SpendCircuit note (secret/salt/blinding). Those remain in the ZK spend path.

## Hash backend honesty

TypeScript still uses **UEP-25 algebraic placeholder** for `h()` unless a Poseidon TS backend is activated.

Rust/circuit uses **Poseidon BN254 t=3 α=5**.

Therefore:

> 37.0 demonstrates **SMT-shaped consensus roots**, not yet bit-identical Poseidon circuit roots.

## Fee / BFT / Aggregate freeze

Unchanged. 36.10 domain tags untouched.

## Tests

`test:37` → 9/9 PASS

## Next (37.1+)

- Optional: wire process-node to SmtEconomicState
- Align leaf encoding with note_commitment when bridging ZK spends
- Optional Poseidon backend in TS or verify roots via uep-zk
