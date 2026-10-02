# UEP-28.6 — Poseidon wallet prove(JSON)

## Track A (this change)

Bind **real spend public inputs** to Groth16 via Poseidon, not a detached fixture.

```
Wallet economic fields
        ↓
PoseidonSpendRequest JSON
        ↓
uep-zk prove-spend-json
        ↓
Rust builds Poseidon SMT + SpendCircuit
        ↓
Groth16 proof + 12 publics (BOUND to this spend)
        ↓
Node verify-hex (no secrets)
```

## Request fields

`sender_secret`, `sender_salt`, `recipient_id`, `treasury_id`, `asset_id`,
`amount`, `fee`, balances, `note_blinding`, recipient/treasury blindings, `depth` ∈ {4,32}.

Rust derives: `sender_id`, leaves, `note_nonce`, nullifier, paths, `transaction_commitment`.

## API

| Layer | Symbol |
|---|---|
| Rust | `prove_request::circuit_from_request`, CLI `prove-spend-json` |
| TS | `buildPoseidonSpendRequest`, `zkProveSpendJson` |
| Provider | `PoseidonWalletProvider` |

## Research track (Track B)

This is **not** a utility-driven protocol change. It closes the gap identified in utility research: *wallet → proof → node without secrets* is a prerequisite for agent/resource applications (class A), not a new economic primitive.

No change to Poseidon parameters, fee formula, or 12-input schema.

## Build

```bash
cd uep-core/uep-26-spend-circuit
cargo build --release --bin uep-zk
```

## Gap remaining

- Full production state tree (many leaves) not yet ingested; request builds a **minimal 3-leaf** state sufficient for the spend.
- D=32 prove is expensive; default tests use D=4.
