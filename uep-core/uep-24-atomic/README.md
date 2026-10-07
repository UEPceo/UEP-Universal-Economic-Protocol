# UEP-24 — Atomic State Transition

UEP-24 supersedes the UEP-23 scaffold.

## Invariants

### Ownership

`SenderID = Poseidon(Secret, AccountSalt)`

### Fee

`Fee = floor(Amount / 1000)`

For amounts divisible by 1000:

`Fee * 10000 = Amount * 10`

### Atomic balances

`SenderNew = SenderOld - Amount - Fee`

`RecipientNew = RecipientOld + Amount`

`TreasuryNew = TreasuryOld + Fee`

### Conservation

`SenderOld + RecipientOld + TreasuryOld`
=
`SenderNew + RecipientNew + TreasuryNew`

### Nullifier

`Nullifier = Poseidon(Secret, Nonce)`

## Important implementation status

This is the **UEP-24 circuit architecture and adversarial-test scaffold**.

The concrete Sparse Merkle Tree authentication/update gadget is intentionally NOT
claimed complete yet. `old_root`, `new_root`, `old_nullifier_root` and
`new_nullifier_root` are public circuit interface values until the actual SMT
path constraints are inserted.

Therefore UEP-24 is **not yet a testnet-ready payment circuit**.

The next required implementation is:

1. Sender SMT membership + update.
2. Recipient SMT membership + update.
3. Treasury SMT membership + update.
4. Nullifier SMT non-membership + insertion.
5. One atomic root transition.
6. Groth16 tests for every attack vector.

## Fee policy

The current policy uses integer floor rounding. Thus amounts 1..999 have fee 0.
This must be explicitly accepted or replaced by a dust-accumulation/minimum-fee
policy before mainnet.

## Rust verification

Run:

```bash
cargo test
cargo test --release
```

Do not make performance claims until the circuit is compiled and benchmarked on
a defined reference machine.

> **Repository note (v0.5.3):** this crate was ported to the pinned arkworks 0.3 API
> and is built and tested by `npm run test:rust` (lab code, development only; no
> performance or security claim).
