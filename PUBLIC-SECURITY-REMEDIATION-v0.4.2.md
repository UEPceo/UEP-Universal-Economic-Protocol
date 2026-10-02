# UEP Public Marketplace + IoT/M2M — v0.4.2 Remediation

This document summarizes how v0.4.2 responds to the external adversarial audit of v0.4.1 (`50017ea`). Status labels are deliberately conservative: **addressed** means the property is enforced by the local reference ledger / Marketplace and covered by a negative test; **partially addressed** means a mitigation exists but the audit's full property is not yet met. The previous status report is [`PUBLIC-SECURITY-REMEDIATION-v0.4.1.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.1.md).

## Findings addressed

1. **Output binding (UEP-B03)** — addressed. `submit()`, pending validation and `restore()` share one rule set (`checkSpendShape`): output 0 must pay exactly `amount` to `recipientId`; output 1 exists only if there is change and must return exactly `input − amount − fee` to the sender; outputs must open against the committed output commitments and carry well-formed note nonces. *Tests:* redirected recipient output, under/over-paid recipient, change sent to the recipient, swapped outputs and dropped change are all rejected (`OUTPUT_BINDING`).
2. **Restore availability (UEP-B02)** — addressed in the local ledger model. Because every accepted transaction now satisfies the same rules that `restore()` checks, an honest ledger's snapshot always restores. *Tests:* a rejected dishonest spend leaves the ledger unchanged and its snapshot restores; honest snapshots restore after a randomized sequence of spends.
3. **Nonce/note binding (UEP-C01)** — addressed. `tx.nonce` must equal the consumed note's nonce, which must itself be well-formed for that note; with the sender's secret, the nullifier is checked to derive from that nonce. *Test:* a re-authorized spend with an unrelated nonce is rejected (`NOTE_NONCE`).
4. **Constant-time integrity check (UEP-C02)** — addressed. The snapshot HMAC is compared with `timingSafeEqual`, before any other processing.
5. **Redundant conservation check (UEP-C03)** — addressed. Replaced by the explicit binding rules above.
6. **Input-membership test coverage (UEP-C05)** — addressed. New test with an input commitment that does not exist in the ledger (`NOTE_NOT_MEMBER`).
7. **Transfer participants (found during integration)** — addressed. Transfers where the sender is also the recipient, or where the treasury account is sender or recipient, produced balances that did not match notes. `prepareSpend()`, `submit()`, pending validation and `restore()` now require sender, recipient and treasury to be distinct (`INVALID_PARTICIPANTS`). *Test:* both cases rejected, balance unchanged.

## Findings partially addressed

- **Forged snapshots (UEP-B05, UEP-A05)** — `restore()` now checks the authority tag first and then re-derives the whole state, rejecting with a specific `INVALID_SNAPSHOT_*` error any snapshot that `faucet()`/`submit()` could not have produced: state root, nullifier root and seen-set, note openings/nonces/duplicates, in-order transaction replay under `submit()`'s rules, spent flag ⇔ consumed by a committed transaction, per-account balance = unspent notes (+ fee income for the treasury), and per-asset minted supply = mint notes = total balances. *Tests:* authority-signed snapshots breaking each invariant are rejected. **Remaining:** the authority secret is symmetric, so its holder can still author a fully consistent history (including faucet mints, whose supply record is self-declared). A non-symmetric or threshold snapshot authority is a design decision for a later release.
- **Free reservations (UEP-A10)** — the Marketplace now charges a reservation deposit by default: 1% of the order's gross amount, minimum 1 unit (`reservationDeposit` for a fixed amount, `reservationDepositBps` for a rate; `0n` disables it explicitly). Funding an order without the deposit fails, and IoT HOLD and the 20k simulation fund it. *Test:* default orders cannot be funded without the deposit. **Remaining:** the deposit is collected when an order is funded, not when capacity is reserved; an unfunded reservation still locks capacity until its TTL, the deposit is released (not forfeited) on expiry, and identities are caller-supplied strings. Charging at reservation time or forfeiting deposits changes the order lifecycle and is left for a design decision.
- **Pending reconciliation (UEP-A06 / UEP-B06)** — unchanged from v0.4.1 plus the binding rules: invalid envelopes are rejected, valid ones stay queued and are never settled without a state transition. Pending validation still has no sender authentication or local membership check, and the queue is unbounded.

## Not addressed in this release

- Marketplace dispute/refund, string identities and listing IDOR (UEP-B07, B08, B12, A07, A09), development MAC and mutable `requireProof` (UEP-A11, A12), fee rounding (UEP-A16), ZK witness range checks (UEP-A22), simulated IoT telemetry (UEP-B13).
- Authenticated note-commitment tree for replicas (input membership is checked against the local note set).

## Deliberate protocol boundary

The public transaction envelope carries a single nullifier, so public testnet spends use exactly one input note (UEP-C04). A balance split across several notes cannot be combined in one spend. A future multi-input format must introduce and commit a nullifier vector before aggregation is enabled.

## Compatibility notes

- Snapshot format version 2 adds `formatVersion` and per-asset `supply`; snapshots taken with v0.4.1 are rejected (`INVALID_SNAPSHOT_VERSION`) and must be re-taken from a running ledger.
- New submit error codes: `OUTPUT_BINDING`, `NOTE_NONCE`, `INVALID_PARTICIPANTS`.
- `DigitalServicesMarketplace.reservationDeposit` is replaced by `fixedReservationDeposit`, `reservationDepositBps` and `reservationDepositFor(grossAmount)`; orders and checkout quotes still expose `reservationDeposit`.

## Verification

- `npm test`: protocol suite 38/38 and Marketplace/IoT suite 44/44 PASS (Node 22 and Node 24).
- `npm run test:scale`: 3/3 PASS; `npm run test:iot`: 15/15 PASS.
- `npm run smoke:testnet` and `npm run quickstart`: PASS.
- `npm run simulate:20k`: 20,000 accepted, funded (including reservation deposit), delivered and settled main-flow operations with 0 errors.

## Remaining production limitations

This repository is a public local testnet implementation. It does not claim production consensus, production ZK proving keys/ceremony, durable distributed snapshot authority, hardware-backed machine attestation, or a production custody/payment rail.
