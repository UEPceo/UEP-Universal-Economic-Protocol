# Changelog

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
