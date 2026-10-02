# UEP Public Marketplace + IoT/M2M — v0.4.4 Remediation

This document summarizes how v0.4.4 responds to items left open after v0.4.3:
- the pending queue (UEP-B06, UEP-A06, UEP-D01);
- Marketplace disputes and order access (UEP-B07, B08, B12, A07, A09);
- fee rounding (UEP-A16);
- unsigned IoT telemetry (UEP-B13);
- the missing authenticated note-commitment tree.

Status labels are deliberately conservative. **Addressed** means the property is enforced by the local reference ledger / Marketplace and covered by a negative test. **Partially addressed** means a mitigation exists but the full property is not yet met.

Previous reports: [`v0.4.3`](./PUBLIC-SECURITY-REMEDIATION-v0.4.3.md), [`v0.4.2`](./PUBLIC-SECURITY-REMEDIATION-v0.4.2.md), [`v0.4.1`](./PUBLIC-SECURITY-REMEDIATION-v0.4.1.md). Changed signatures: [`docs/API.md`](./docs/API.md).

## Findings addressed

1. **Pending queue validation (UEP-B06, UEP-A06, UEP-D01)**: addressed on the local reference ledger.
   - *Sender authentication.* Every spend carries an Ed25519 signature by the sender's registered spend key, derived deterministically from the account credentials. Registering the key requires proving control of the account. `submit()` and the pending queue both require the signature; `submit()` requires it even when the development ownership proof is disabled.
   - *Local existence.* A queued spend must consume a note that exists unspent in the local ledger, with transported fields matching the canonical note. The same `checkSpendShape()` rules as `submit()` apply to the canonical input, and it needs a valid note-membership proof.
   - *Bound.* The queue is bounded (`maxPendingTransactions`, default 1024, configurable) and de-duplicated. Offline `submit()` validates before queueing.
   - *Restore.* `restore()` re-validates every pending entry against the restored state and rejects over-bound, duplicate or invalid queues. Snapshots export only entries that still validate.
   - *Settlement.* Reconciliation still never settles, and spends that share an input are flagged as in conflict.
   - *Tests:* unsigned, wrong-key and unregistered senders; non-member, mismatched-opening, bad-shape and already-spent inputs; queue bound; offline submit validation; shared-input conflict flag; restore of a snapshot carrying an invalid pending entry; sender signature required when the ownership proof is disabled.
2. **Authenticated note-commitment tree**: addressed for the local reference ledger and signed snapshots.
   - *Tree.* An append-only Merkle tree (depth 32) of note commitments. Its root and size are part of the snapshot.
   - *Spends.* Every spend carries a membership proof for its input against a historical root.
   - *Restore.* Restore rebuilds the tree from the notes, checks the root, and re-checks each replayed spend's proof (anchored before its own outputs) and sender signature. A replica holding only a root can verify a note's existence (`verifyNoteMembership`).
   - *Tests:* proof verification and tampering; submit with a missing or wrong proof; restore with a wrong root, a stripped proof, a missing sender signature or an unproven spend-key registration; rejection of the previous snapshot format.
3. **Marketplace disputes and order access (UEP-B07, UEP-B08, UEP-B12, UEP-A07, UEP-A09)**: addressed in the Marketplace layer.
   - *Signed actions.* Every order action and read is an Ed25519-signed action bound to the Marketplace, action, actor, order and details. Providers must be registered identities. The admin and the settlement arbiter are verified against configured public keys; without an admin key no admin action is possible. Plain identity strings are refused.
   - *Order access.* Reading an order requires being its buyer, its provider or the admin, plus the arbiter once a dispute exists. Listing returns only the signer's own orders, and the admin sees all. Read authorizations expire after a short TTL (default 5 minutes).
   - *Disputes.* Only the buyer can open a dispute on its own order, within the delivery dispute window, and only when an arbiter is configured. Only the arbiter can resolve it, as `RELEASE`, `REFUND_BUYER` or `SPLIT`. The provider can concede a refund, and the buyer can withdraw. An unresolved dispute falls back to a configurable timeout outcome after the resolution window (default: refund the buyer).
   - *Settlement rights.* The provider can claim payment only after the dispute window, and the admin cannot settle.
   - *Value.* Every outcome moves the escrow exactly once. A split charges the Marketplace fee only on the provider's share, and a refund returns gross plus gas and releases any paymaster sponsorship. Value accounting stays conserved on every path.
   - *Reserved identities.* `marketplace-system` is now reserved together with the admin and arbiter identifiers.
   - *Tests:*
     - every dispute outcome, withdrawal, provider refund and timeout, each with conservation;
     - disputes opened or resolved by non-parties, by the provider or by the admin;
     - the provider's claim window;
     - cross-user read, list and modify attempts;
     - impersonated provider, admin and arbiter.
4. **Fee rounding (UEP-A16)**: addressed. The 0.1% protocol fee and the 3% Marketplace fee keep their documented rates and now have a minimum of 1 unit for any positive amount. Above roughly 1,000 and 34 units respectively, they are unchanged. *Tests:* small protocol transfers and small Marketplace settlements pay at least 1 unit, and zero-fee envelopes are rejected.
5. **IoT telemetry authenticity (UEP-B13)**: addressed for authenticity of the report; physical delivery is still not proven.
   - *Signed reports.* The unsigned simulated mode is removed. Machines must be registered with an Ed25519 public key by their provider (signed), and every telemetry report must be signed by that key.
   - *Anti-replay.* Monotonic sequence numbers and single-use nonces.
   - *What is signed.* The signed payload includes the delivered units.
   - *Settlement.* An IoT order is released only against verified telemetry that the provider delivered for that order and that reports the full contracted quantity. A shortfall must go through a dispute, with the verified usage amount available to the arbiter.
   - *Simulations.* They sign with test machine keys.
   - *Tests:* unregistered key; wrong key; replayed sequence and nonce; tampered measurements; units above the contracted quantity; telemetry not delivered for the order; settlement before verification; shortfall resolved by a split; signed provider/machine registration and deactivation.

## Findings partially addressed

- **Spend-key registry trust**: a replica receives the spend-key registry through signed snapshots. It can verify signatures against registered keys, but cannot independently re-check the account-control proof behind a registration made on another node.
- **Development MAC and mutable `requireProof` (UEP-A11, UEP-A12)**: the development MAC and the configurable flag are unchanged. Since every spend now also needs an Ed25519 sender signature by the registered key, disabling the flag no longer removes sender authentication.

## Residual trust model

The snapshot-authority and faucet-key trust model of v0.4.3 is unchanged. In addition:

- The settlement arbiter is a trusted party for disputed outcomes. It cannot move more than the escrowed value.
- A machine key proves who signed a telemetry report, not that the physical service took place.
- There is no key rotation or revocation for spend, identity, admin, arbiter or machine keys.
- A signed read authorization can be reused by its holder until it expires.
- Marketplace identity registration is still self-service and not Sybil resistance, and `creditAccount()` is still a testnet funding stub.
- An explicit zero reservation deposit remains a configuration option (UEP-D02).

## Not addressed in this release

- ZK witness range checks (UEP-A22).
- Remaining lower-priority items (UEP-A17–A25) not listed above.

## Deliberate protocol boundary

The public transaction envelope carries a single nullifier, so public testnet spends use exactly one input note (UEP-C04).

## Compatibility notes

- *Snapshot format.* Format 4 is required, and v0.4.3 snapshots must be re-taken. Snapshots add the note root and count, the spend-key registry and the pending bound.
- *Transactions.* Spends carry `senderAuth` and `inputMembership`; `prepareSpend()` attaches both. Hand-built transactions must add them. `queueConflict()` now returns a submit result.
- *Fees.* Positive amounts below the thresholds above pay 1 unit instead of 0.
- *Marketplace.* Every order call takes a signed `ActorAuth` instead of an identity string. The calls affected are publish, fund, deliver, settle, cancel, expire, read, list and review. The admin requires `adminPublicKey`, and a configured arbiter requires `settlementArbiterPublicKey`. `marketplace-system` cannot be registered. `MARKETPLACE_VERSION` is `0.4`.
- *IoT/M2M.* Machines require `publicKeyHex`. Provider and machine registration, deactivation, hold, delivery, settlement and reads are signed. `simulateExecution()` requires the machine's private key. Telemetry includes `unitsDelivered`.

## Verification

- `npm test`: protocol suite 61/61 and Marketplace/IoT suite 77/77 PASS (Node 22 and Node 24).
- `npm run test:scale`: 3/3 PASS; `npm run test:iot`: 22/22 PASS.
- `npm run smoke:testnet` and `npm run quickstart`: PASS.
- `npm run simulate:20k`: 20,000 signed, funded, delivered and settled main-flow operations with 0 errors and value conserved.

## Remaining production limitations

This repository is a public local testnet implementation. It does not claim production consensus, production ZK proving keys/ceremony, production key custody or rotation, hardware-backed machine attestation, an independent dispute-resolution service, or a production custody/payment rail.
