# UEP Public Marketplace + IoT/M2M — v0.4.1 Remediation

This document summarizes how v0.4.1 responds to the external adversarial audit of v0.4.0 (`676fee6`). Status labels are deliberately conservative: **addressed** means the property is enforced by the local reference ledger and covered by a negative test; **partially addressed** means a mitigation exists but the audit's full property is not yet met.

## Findings addressed

1. **Transaction-supplied input notes (UEP-B01, UEP-A04)** — addressed for a single ledger. `submit()` resolves every input commitment against an existing unspent note in the receiving ledger and verifies that the transported opening matches the canonical note; the ledger's own spent flag is authoritative. A transaction cannot create its own input membership. This is local membership, not an authenticated note-commitment tree, so it does not yet make replicas safe.
2. **Exact-amount spend (UEP-B04)** — addressed. Note selection requires one note that covers `amount + fee`; otherwise `prepareSpend` returns a structured `INSUFFICIENT` error instead of producing a transaction that `submit()` would reject.
3. **IoT settlement authorization (UEP-B09)** — addressed. `settle(requestId, actorId)` rejects anonymous callers and actors other than the buyer or the configured settlement arbiter.
4. **IoT reservation deposit (UEP-B10)** — addressed. `hold()` funds gross amount + gas fee + reservation deposit.
5. **Machine/provider deactivation (UEP-B11)** — addressed. Deactivation requires an explicit admin authorizer (fail-closed when none is configured).

## Findings partially addressed

- **Forged snapshots (UEP-B05, UEP-A05)** — snapshots carry an HMAC integrity record keyed by an external `snapshotAuthoritySecret`; a snapshot produced or modified without that secret is rejected. `restore()` also rebuilds the state and nullifier roots and re-checks every note opening, transaction commitment and transaction value conservation. The authority secret is symmetric: anyone holding it can authenticate arbitrary state, and restore does not yet check that unspent notes sum to balances, that the nullifier `seen` set matches the tree, or total supply.
- **Snapshot restore availability (UEP-B02)** — honest snapshots restore after any number of transactions (regression-tested), and fabricated input notes can no longer enter the note set. The finding is not considered closed while output notes are not bound to the declared recipient and amount (UEP-B03).
- **Pending reconciliation (UEP-A06 / UEP-B06)** — invalid pending envelopes are rejected; valid ones stay queued (`LOCAL_VALID`, flagged on conflict) and are never marked settled or added to the transaction history without a state transition. Pending validation still has no sender authentication and the queue is unbounded.

## Not addressed in this release

- **UEP-B03** — output notes are checked for value conservation but not bound to `recipientId` / `amount`.
- Marketplace dispute/refund, string identities and listing IDOR (UEP-B07, B08, B12, A07, A09, A10), development MAC and mutable `requireProof` (UEP-A11, A12), fee rounding (UEP-A16), ZK witness range checks (UEP-A22), simulated IoT telemetry (UEP-B13).

## Deliberate protocol boundary

The public transaction envelope currently carries a single nullifier. To avoid a second-input nullifier gap, v0.4.1 deliberately restricts public testnet spends to one input note. A user whose balance is split across several notes cannot combine them in one spend. A future multi-input format must introduce and commit a nullifier vector before aggregation is enabled.

## Integration fixes

Two defects in the submitted v0.4.1 ledger code were fixed during integration, with regression tests:

- `restore()` and pending validation used a value-conservation rule inconsistent with `submit()`, so honest snapshots containing any transaction could not be restored and every honest pending transaction was rejected. Both now use the same rule as `submit()`.
- Pending reconciliation reverted to promoting validated transactions to settled without applying them, and in practice silently discarded every pending transaction. The v0.4.0 queue-and-flag semantics are restored.

## Verification

- `npm test`: protocol suite 30/30 and Marketplace/IoT suite 43/43 PASS (Node 22 and Node 24).
- `npm run test:scale`: 3/3 PASS.
- `npm run smoke:testnet` and `npm run quickstart`: PASS.
- `npm run simulate:20k`: 20,000 accepted, funded, delivered and settled main-flow operations with 0 errors.

## Remaining production limitations

This repository is a public local testnet implementation. It does not claim production consensus, production ZK proving keys/ceremony, durable distributed snapshot authority, hardware-backed machine attestation, or a production custody/payment rail.
