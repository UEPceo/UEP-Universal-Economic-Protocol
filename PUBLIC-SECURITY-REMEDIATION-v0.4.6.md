# UEP Public Marketplace + IoT/M2M — v0.4.6 Remediation

This document covers the two new P3 findings of the external review of v0.4.5 (UEP-D04, UEP-D05).

Status labels are deliberately conservative:
- **Addressed** means the property is enforced by the local reference Marketplace and covered by a negative test.
- **Partially addressed** means a mitigation exists but the full property is not yet met.

Previous reports: [`v0.4.5`](./PUBLIC-SECURITY-REMEDIATION-v0.4.5.md), [`v0.4.4`](./PUBLIC-SECURITY-REMEDIATION-v0.4.4.md), [`v0.4.3`](./PUBLIC-SECURITY-REMEDIATION-v0.4.3.md), [`v0.4.2`](./PUBLIC-SECURITY-REMEDIATION-v0.4.2.md), [`v0.4.1`](./PUBLIC-SECURITY-REMEDIATION-v0.4.1.md). Changed signatures: [`docs/API.md`](./docs/API.md).

## Findings addressed

1. **Dispute timeout releasing a guarded order (UEP-D04, P3/configuration)**: addressed for every unattended release path.
   - *Timeout.* A dispute that times out under `disputeTimeoutOutcome: "RELEASE"` now runs the category settlement guard before any payout.
     - For IoT/M2M orders the guard requires verified telemetry: it must be bound to the report delivered for that order and must cover the order's full quantity.
     - If the guard does not pass, the order closes as a full refund to the buyer (`REFUND_BUYER`, `TIMEOUT_REFUND_UNVERIFIED`): gross amount and gas are returned and no fee is charged.
   - *Coverage.* The guard is applied to every release path that does not involve the arbiter's explicit decision:
     - normal settlement of a delivered order;
     - the buyer's dispute withdrawal;
     - the timeout.
   - *Scope.* It applies to any category with an attached guard. An IoT listing without an attached IoT service can never be released this way.
   - *Defence in depth.* The IoT guard also checks the verified units against the order quantity.
   - *Arbiter resolution.* The arbiter's explicit release or split remains a trusted, final decision, as documented since v0.4.4. For guarded categories the settlement record now states whether the guard passed (`categoryGuard`), so overrides are visible.
   - *Default.* The default timeout outcome is still a refund, and its behaviour is unchanged.
   - *Tests:*
     - a release timeout with verified telemetry pays the provider;
     - without verified telemetry the buyer is refunded in full, value stays conserved, and repeated calls return the same record;
     - a verified shortfall is refunded;
     - an IoT listing without its service is refunded;
     - a custom guard on another category gates the timeout, while unguarded categories still release;
     - the default timeout and the guarded withdrawal behave as before;
     - the arbiter's explicit release is labelled.
2. **Capacity not returned after post-delivery outcomes (UEP-D05, P3)**: addressed.
   - *Exactly once.* When an order closes, capacity is returned once, and the amount is recorded on the order.
     - Cancellation and expiry (nothing delivered) return the full quantity, as before.
     - A full release consumes the full quantity.
     - A refund or split returns the quantity minus the consumed units.
   - *Consumed units* are the larger of:
     - the units proven executed by category evidence (for IoT: verified telemetry of the delivered report);
     - the units paid for, rounded up.
     - So an IoT service actually executed per verified telemetry keeps its executed units consumed even when the buyer is refunded.
   - *No over-filling.* The return is computed and checked before any value moves. Category evidence is clamped to the order quantity. A second return or a return that would exceed the listing's capacity is refused.
   - *Accounting.* A new `capacityAccounting()` check verifies `capacity = available + reserved + consumed` per listing.
   - *Tests:*
     - refund returns capacity once, across every replay path;
     - provider refund, timeout refund and release;
     - a split returns only the unpaid units;
     - IoT executed units stay consumed on refund and split;
     - out-of-range evidence is clamped;
     - repeated fill-and-drain rounds keep `available` within `[0, capacity]` and the accounting conserved.

## Choices made

- **Safe timeout outcome.** A failed guard falls back to a full refund rather than a split by verified usage. A split needs a judgement about partial value, and that judgement stays with the arbiter.
- **Capacity rule.** Capacity follows the same evidence the Marketplace pays on.
  - Verified execution is consumed.
  - Unpaid and unproven units are returned.
  - Paid units are rounded up so that a split never returns more than its unpaid share.

## Findings partially addressed

- **Arbiter trust.** The arbiter's explicit release of a guarded order is labelled but not blocked. This is a documented trust decision, not an automated guarantee.
- **Development MAC and mutable `requireProof` (UEP-A11, UEP-A12).** Unchanged since v0.4.5.

## Residual trust model

The v0.4.5 model for snapshot authority, faucet key, arbiter and machine keys is unchanged. In addition:

- Verified telemetry proves which registered machine key signed a usage report, not that the physical service happened. A compromised or dishonest machine can still report false usage, and that usage then counts as consumed capacity.
- An IoT execution that was delivered but never verified is treated as not consumed. Its capacity is returned on refund, consistent with the refund itself.
- For non-IoT categories, consumption is inferred from payment. A refund returns the full quantity even if the provider did some work.

## Not addressed in this release

- ZK witness range checks (UEP-A22).
- Self-service identity registration (not Sybil resistance).
- The `creditAccount()` testnet stub.
- Key rotation and revocation.
- Read authorizations reusable within their TTL.
- Lower-priority items (UEP-A17–A25) not listed above.

## Compatibility notes

- *RELEASE timeouts.* A Marketplace configured with `disputeTimeoutOutcome: "RELEASE"` now refunds a timed-out dispute whose category guard fails, instead of paying it.
- *Capacity.* Post-delivery refunds and splits now return unconsumed capacity.
- *Types.* All type changes are additive: a new dispute outcome value, new settlement-record and order fields, an optional `consumedUnits` category hook, and `capacityAccounting()`.
- *Formats.* No ledger, address or snapshot format change.

## Verification

- `npm test`: protocol suite 67/67 and Marketplace/IoT suite 94/94 PASS (Node 22 and Node 24).
- `npm run test:scale`: 3/3 PASS; `npm run test:iot`: 23/23 PASS.
- `npm run smoke:testnet`, `npm run quickstart` and `npm run simulate:20k`: PASS.

## Remaining production limitations

This repository is a public local testnet implementation. It does not claim:
- production consensus;
- production ZK proving keys or ceremony;
- production key custody or rotation;
- hardware-backed machine attestation;
- an independent dispute-resolution service;
- a production custody or payment rail.
