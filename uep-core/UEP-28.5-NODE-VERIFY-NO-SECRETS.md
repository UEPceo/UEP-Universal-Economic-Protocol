# UEP-28.5 — Node verifies without secrets

## Goal

```
Wallet  →  proof artifacts
Node    →  verify(vk, proof, public_inputs)   # no user secret
        →  state transition
```

## Rust CLI (`uep-zk`)

| Command | Role |
|---|---|
| `prove-export-d4` | Setup+prove honest Poseidon fixture D=4; print `vk_hex`, `proof_hex`, `public_0..11` |
| `verify-hex` | Stdin: vk/proof/publics hex → `ok=true/false` (independent of prover) |

Build (when registry available):

```bash
cd uep-core/uep-26-spend-circuit
cargo build --release --bin uep-zk
```

## TypeScript

- `zkProveExportD4()` / `zkVerifyHex()` in `zk-bridge.ts`
- `LocalRustFixtureProvider` + `verifyZkSpendProofIndependent()`
- `UepLedger.submit(tx, { zkProof })` — verifies SNARK **without** secrets
- `ledger.requireProof = true` — rejects bare submits

## Explicit gap

`prove-export-d4` proves the **Rust fixture**, not an arbitrary wallet `ZkSpendInstance`.
Binding wallet public inputs into the SNARK requires Poseidon witness material from the wallet (next slice).

Architecture path is open: node can already reject invalid proofs without learning the secret.

## Tests

- `requireProof` rejects submit without secrets/zkProof
- MAC path still works with secrets
- Groth16 independent verify tests **skip** if `uep-zk` binary missing
