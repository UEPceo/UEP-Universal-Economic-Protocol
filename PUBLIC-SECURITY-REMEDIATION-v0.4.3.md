# UEP Public Marketplace + IoT/M2M — v0.4.3 Remediation

This document summarizes how v0.4.3 responds to the two items v0.4.2 left as design decisions: snapshot authority (UEP-B05, UEP-A05) and free reservations (UEP-A10). Status labels are deliberately conservative: **addressed** means the property is enforced by the local reference ledger / Marketplace and covered by a negative test; **partially addressed** means a mitigation exists but the full property is not yet met. Previous reports: [`v0.4.2`](./PUBLIC-SECURITY-REMEDIATION-v0.4.2.md), [`v0.4.1`](./PUBLIC-SECURITY-REMEDIATION-v0.4.1.md). Changed signatures: [`docs/API.md`](./docs/API.md).

## Findings addressed

1. **Snapshot authority (UEP-B05, UEP-A05)**: addressed within the testnet trust model.
   - *Asymmetric signatures.* The shared HMAC secret is replaced by Ed25519 signatures (`node:crypto`). `restore()` takes only public trust anchors.
   - *Threshold.* An optional k-of-n authority set requires `k` valid signatures from distinct listed authorities. Duplicates count once and unknown keys carry no weight. The default is 1-of-1.
   - *Continuity.* Each snapshot is linked by `sequence` and `prevSnapshotHash`. Restore can be pinned to a known previous hash or checkpoint, and `restoreChain()` verifies an ordered series.
   - *Issuance.* Every faucet mint must carry a valid signature from a dedicated faucet key that cannot also be a snapshot key. Every note must be either a signed mint or a transaction output, and supply is derived from the signed mints. A party holding only snapshot keys therefore cannot create value that restores.
   - *Format.* Format version 3 is required. Older formats are rejected with an explicit message.
   - *Tests:* wrong key; one signature when 2-of-3 is required; duplicate signer; chain break, reorder and rollback; rewritten history rejected against a checkpoint; unsigned mint; foreign-key mint; forged history signed by the snapshot key with a fake mint; faucet/snapshot key separation; legacy secret refused; verify-only restore cannot sign or mint.
2. **Free reservations (UEP-A10)**: addressed for the approved design.
   - *Who can reserve.* Only identities with a registered Ed25519 key, using a buyer signature over the reservation terms. This is fail-closed.
   - *Deposit.* Default 1% of gross, minimum 1 unit, configurable. It is locked from the buyer's balance when capacity is reserved, so there is no reservation without funds, and it counts toward the payment when funded.
   - *Deposit outcomes.* It is forfeited to the provider on unfunded expiry or a buyer cancellation after the grace window (default 2 minutes), and refunded on cancellation within the window. Provider/admin cancellation and expiry of a funded undelivered order refund the buyer in full. Expiry cannot be triggered before the TTL.
   - *Limits.* Per-identity concurrent reservation limit (default 8) and a short TTL (default 10 minutes).
   - *Conservation.* Value is checked on every path (`valueAccounting`). IoT `hold()` and `simulate:20k` run the signed, funded flow.
   - *Tests:* unregistered identity; wrong key or altered terms; reserve without funds; funded path; expiry forfeit; funded expiry refund; cancel within grace refunds; cancel after grace forfeits; unsigned buyer cancel rejected; provider/admin refunds; concurrency limit; signed replay locks once; conservation across all paths including paymaster gas.

## Findings partially addressed

- **Order ID scoping (part of UEP-B12)**: reserving with an `orderId` that already exists now fails (`ORDER_ID_CONFLICT`) instead of returning that order. Registration refuses reserved administrator and arbiter identifiers. Order listing pages are still not actor-scoped.
- **Pending reconciliation (UEP-A06 / UEP-B06)**: unchanged from v0.4.2. Valid envelopes stay queued and are never settled without a state transition. Pending validation still has no sender authentication or local membership check, and the queue is unbounded.

## Residual trust model

Whoever holds the snapshot authority private keys controls what their own node signs, and whoever holds the faucet key controls testnet issuance on that node. The controls above make tampering by others detectable and keep the two roles separate. They do not make a key holder honest, and they are not production consensus. In addition:

- There is no key rotation or revocation.
- Checkpoints and trust anchors are distributed out of band.
- A checkpoint more than one snapshot behind is checked by transaction/mint history prefix, not by every intermediate link. Use `restoreChain()` for full linkage.
- Marketplace identity registration is self-service. A new identity costs nothing beyond the deposit it must fund, so this is not Sybil resistance.
- `creditAccount()` is a testnet funding stub, not a payment rail.
- Provider and admin actor identifiers are still caller-supplied strings.
- `fundOrder()` is not separately signed. It can only move the buyer's own balance into escrow for an order the buyer signed.
- Cancellation within the grace window is free by design, so a funded identity can hold up to its concurrency limit of capacity for that window.

## Not addressed in this release

- Marketplace dispute/refund flow, listing IDOR and remaining string-identity actor checks (UEP-B07, B08, A07, A09).
- Development MAC and mutable `requireProof` (UEP-A11, A12).
- Fee rounding (UEP-A16).
- ZK witness range checks (UEP-A22).
- Simulated IoT telemetry (UEP-B13).
- Authenticated note-commitment tree for replicas.

## Deliberate protocol boundary

The public transaction envelope carries a single nullifier, so public testnet spends use exactly one input note (UEP-C04).

## Compatibility notes

- *Ledger construction.* `snapshotAuthoritySecret` is removed (throws `SNAPSHOT_SECRET_UNSUPPORTED`). Use `snapshotSigningKeys` and `faucetSigningKey`.
- *Restore.* `UepLedger.restore(snapshot, secret)` becomes `restore(snapshot, trust, keys?)`. `signSnapshotPayload()` is removed.
- *Snapshot format.* The `integrity` and `supply` fields are removed and format 3 is required. Snapshots from v0.4.2 or earlier must be re-taken.
- *Faucet.* `faucet()` requires a faucet key and a positive amount.
- *Reservations.* `acceptOrder()` / `reserve()` require a registered buyer, `idempotencyKey`, `signature` and funds for the deposit.
- *Funding.* `fundOrder()` now takes `grossAmount + gasFee − reservationDeposit`.
- *Cancellation and expiry.* A buyer `cancel()` requires a signature. `expire()` before the TTL throws.
- *Quotes.* `checkoutQuote().buyerTotal` no longer adds the deposit on top.
- *IoT.* `requestService()` requires `idempotencyKey` and `authorization`.

## Verification

- `npm test`: protocol suite 49/49 and Marketplace/IoT suite 57/57 PASS (Node 22 and Node 24).
- `npm run test:scale`: 3/3 PASS; `npm run test:iot`: 16/16 PASS.
- `npm run smoke:testnet` and `npm run quickstart`: PASS.
- `npm run simulate:20k`: 20,000 signed, funded, delivered and settled main-flow operations with 0 errors and value conserved.

## Remaining production limitations

This repository is a public local testnet implementation. It does not claim production consensus, production ZK proving keys/ceremony, production key custody or rotation for snapshot and faucet keys, hardware-backed machine attestation, or a production custody/payment rail.
