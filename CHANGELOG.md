# Changelog

## 0.4.1-public-iot-m2m — 2026-10-02

Ledger and IoT/M2M hardening following the external adversarial audit of v0.4.0 (`676fee6`). See [`PUBLIC-SECURITY-REMEDIATION-v0.4.1.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.1.md) for the per-finding status.

### Ledger

- Input notes must be existing unspent members of the receiving ledger; transaction-carried notes are evidence and must match the canonical note. They cannot mint balances.
- The public testnet transaction format is explicitly single-input while the envelope exposes one nullifier; multi-input aggregation is deferred until a nullifier vector is introduced.
- `prepareSpend` selects one note covering `amount + fee` and otherwise returns a structured `INSUFFICIENT` error.
- Snapshots are integrity-authenticated with an HMAC keyed by an external `snapshotAuthoritySecret`, which is never embedded in the snapshot; `UepLedger.restore(snapshot, authority)` requires it.
- `restore()` validates state/nullifier roots, note commitments, transaction commitments, transaction value conservation and snapshot integrity.

### IoT/M2M

- `settle(requestId, actorId)` requires the buyer or the configured settlement arbiter.
- IoT HOLD funds gross amount, gas fee and reservation deposit.
- Provider/machine deactivation requires an explicit administrator authorization callback.

### Fixed during integration

- `restore()` and pending validation used a value-conservation rule inconsistent with `submit()`: honest snapshots containing any transaction could not be restored and honest pending transactions were rejected. Both now apply the same rule as `submit()`.
- Pending reconciliation had reverted to marking validated transactions settled without applying them (and in practice discarded every pending transaction). The 0.4.0 semantics are restored: invalid envelopes are rejected; valid ones stay queued (`LOCAL_VALID`, flagged on conflict) until applied through authenticated `submit()`.
- Restored from 0.4.0: sorted insertion in the reservation-expiry queue, non-zero exit of the 20k simulation on errors, the deterministic BIP-39 checksum test, the CI workflow and badge, the project contact address, the README "Supporting the project" section and the full changelog history.
- `ledger-hardening.test.ts` runs once (protocol suite); restore tampering tests assert the precise error again.
- New regression tests: honest snapshot restore after several submits, valid pending transaction surviving reconciliation and restore, exact-amount spend without fee coverage, reuse of a spent input note, fabricated input note, foreign-authority snapshot, IoT settlement/deactivation authorization and deposit-aware HOLD.

### Known open issues

- Output notes are checked for value conservation but are not bound to the declared recipient and amount.
- The snapshot authority secret is symmetric; restore does not yet check that unspent notes sum to balances, that the nullifier `seen` set matches the tree, or total supply.
- Input membership is checked against the local note set; there is no authenticated note-commitment tree yet.
- A balance split across several notes cannot be spent in a single transaction until multi-input spends are supported.
- Pending validation has no sender authentication and the pending queue is unbounded.
- Sender authentication is still a development MAC that requires the spender's secret on the node, and `requireProof` can still be disabled.
- Marketplace: no dispute/refund flow; identities are caller-supplied strings; reservation deposit defaults to 0; order listings and `acceptOrder` with an existing `orderId` are not actor-scoped.
- Testnet and Marketplace fees still round down to zero for small amounts; the ZK witness contract is unchanged (not wired, no u64 range checks).

### Verification

- `npm test`: protocol suite 30/30, Marketplace/IoT suite 43/43 (Node 22 and Node 24).
- `npm run test:scale`: 3/3; smoke test and quickstart pass.
- `npm run simulate:20k`: 20,000/20,000 main-flow settlements, 0 errors.

## 0.4.0-public-iot-m2m — 2026-10-02

Public repository updated with the agreed Marketplace + IoT/M2M implementation and security hardening, addressing part of the external audit of v0.3.2 (`fde6e26`).

### Ledger

- Full 254-bit BN254 account/nullifier SMT keys.
- Fee-aware change calculation.
- Transaction-carried input/output notes with commitment verification.
- Snapshot root and note/nullifier integrity validation.
- Security-policy state retained by snapshots.
- Pending transactions are validated during reconciliation: invalid envelopes are rejected; valid ones stay queued (never marked settled without applying the transfer) until applied through authenticated `submit()`.
- Zero-value transfers rejected.

### Marketplace

- IoT/M2M service category.
- Actor identity required for order access and settlement actions.
- Delivered orders cannot be cancelled or expired.
- Reserved legacy admin identity blocked.
- Reservation deposit/identity limits and ordered expiration queue.
- Paymaster quote revalidation.
- Treasury withdrawal authorization verification.

### IoT/M2M

- Provider and machine registration.
- Optional Ed25519 machine identity.
- Deterministic canonical CBOR telemetry.
- Sequence, nonce, replay and freshness protection.
- Marketplace-backed HOLD → delivery → verification → settlement lifecycle.

### Fixed during integration

- Pending reconciliation silently dropped every pending transaction (result check never matched) and its value-conservation check double-counted the amount.
- The 20k Marketplace simulation did not pass a settlement actor (all 20,000 settlements failed) and exited successfully on errors; it now settles all orders and exits non-zero on any error.
- The reservation-expiry queue was fully re-sorted on every order (20k orders took ~3.2 s); it now uses sorted insertion (~60 ms).
- `ledger-hardening.test.ts` ran twice (in both protocol and marketplace suites); it now runs once, in the protocol suite.

### Known open issues

- Sender authentication is still a development MAC that requires the spender's secret on the node, and `requireProof` can still be disabled.
- Multi-input spends still insert a single nullifier.
- Pending/offline transactions cannot yet be applied by reconciliation (they need authenticated `submit()`).
- Snapshot restore does not check that unspent notes sum to balances or that the nullifier `seen` set matches the tree.
- Input notes carried by a transaction are not checked for membership in the receiving ledger (no note-commitment tree).
- Marketplace identities are caller-supplied strings; reservations are free by default (deposit 0) and sybil identities are not limited; `acceptOrder` with an existing `orderId` returns that order to any caller.
- Gas-quote expiry is not checked against the Paymaster's own quote.
- Testnet and Marketplace fees still round down to zero for small amounts.
- The ZK witness contract is unchanged (not wired, no u64 range checks).
- IoT/M2M was not covered by the external audit of v0.3.2.

This remains a local/testnet reference implementation; production distributed infrastructure and production ZK are not claimed.

## 0.3.2-public-security-fix — 2026-10-02

Security release following external review UEP-RR-2026-10-02-001.

- Replaced the reversible/commutative public UEP-25 algebraic hash placeholder with an ordered SHA-256-to-field reference backend.
- Enabled sender proof/authentication by default (`requireProof=true`). The development MAC remains explicitly non-ZK.
- Enforced security policy at transaction submission, not only wallet preparation.
- Bound transaction commitments and TxIDs to `domainId`; added explicit input/output cardinality markers.
- Enforced input-note value >= amount + fee and unique/exact input commitments.
- Fixed `snapshot()` by importing `serializeTx` and added restore coverage.
- Prevented reconciliation from overturning already-applied local transactions. Pending conflicts cannot invalidate a committed nullifier.
- Restricted Marketplace cancellation to buyer/provider/admin and expiration to marketplace-system/admin.
- Added adversarial regression tests for forged identities, proof bypass, policy bypass, value inflation, domain replay, snapshot/restore, hash ordering and unauthorized Marketplace actions.
- IoT/M2M is intentionally **not included** in this public release; it remains in the laboratory/master branch pending its separate audit.

## 0.3.1-public-preview — October 2026

- Added `npm run example` as the canonical public quickstart command.
- Switched the public repository license to Apache-2.0.
- Added explicit test-seed/BIP-39 disclosure and project contact addresses.
- Added a committed npm lockfile for reproducible installation.

## 0.3.0-public-preview — October 2026

### Added

- Public reproducible UEP TESTNET reference layer.
- Local in-process UEP ledger.
- Public testnet identity, transaction, note, nullifier and SMT primitives.
- Deterministic testnet smoke test.
- First-transaction reproducibility example.
- Explicit public scope boundary.
- Public architecture and threat-model documentation.
- Marketplace + testnet in one public repository.

### Retained from public Marketplace preview

- Marketplace listings and orders.
- HOLD / reservation lifecycle.
- Delivery integrity checks.
- Marketplace Treasury.
- 3% settled Marketplace fee.
- Paymaster accounting.
- Reputation and security tests.
- Synthetic 20k load simulation.

### Explicitly not promoted to production status

- ZK production proving/verification.
- Global consensus.
- Live public network endpoints.
- Interplanetary settlement.
- Production custody or payment rails.
