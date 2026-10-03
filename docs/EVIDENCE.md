# Evidence: trust model and value caps

This page describes what evidence means in UEP and how much value it can move. Background: `docs/adr/0002-deterministic-transitions.md` (rule 6). Phase 2.3 of `ROADMAP.md` (Evidence system) will add the evidence records. The parameters and checks below are already in place and are meant to be reused unchanged.

## What evidence certifies

Evidence certifies only this:

> Source X published data D at height H, signed by k of n attesters.

It does **not** certify that D is true, complete or current. It does not certify that the source is honest. If a public source publishes a wrong value, every honest attester signs that same wrong value, and the evidence is valid.

Consequences:

- External data never enters the state directly. An adapter outside the state machine reads the source, and attesters sign a statement about what was published. Only the statement (hashes, height, signatures) would enter the state. The data stays outside.
- A transition never calls the source and never reads the clock (rule 1). If the source is unreachable, no evidence arrives, and the contract's window and default rules apply in the same way on every node.
- H is a block height of the settling ledger, not a timestamp from the source or from a block header.
- A statement is bound to one order (contract) so that it cannot be replayed in another.

The planned statement shape is the `EvidenceStatement` type in `src/marketplace/evidence.ts`: `sourceId`, `dataHash` (SHA-256 of the published bytes), `observedHeight`, `orderId`, `attesterSetId` and `signatures`. The code does not verify statements yet.

## Value caps

Since evidence can be wrong while valid, the value it can move is limited at two levels. Amounts are in the smallest unit of one asset. Amounts of different assets are never added together.

| Parameter | Where | Default | Checked |
|---|---|---|---|
| `maxValuePerContract` | `evidencePolicy` of a listing, declared at publication; part of the signed listing terms; immutable | none: required for an evidence-bound listing; must be > 0 and ≤ the set's cap for the listing asset | at `reserve()` (gross amount + gas of the order) and again at settlement (defence in depth: the amount cannot change after `reserve()`, so the second check is redundant while terms are frozen) |
| `valueCaps[asset]` | `AttesterSetPolicy` in the Marketplace config (`evidence.attesterSets`) | no attester sets are configured, so no listing can be bound to evidence | at `fundOrder()`: funded open value of the set in that asset + the order ≤ cap; `reserve()` checks the same without taking anything (fail early) |

An attester set is `{ attesterSetId, sourceId, attesterKeys, threshold: k, size: n, valueCaps }` with 1 ≤ k ≤ n, `sourceId` the public identifier of the observed source, and `attesterKeys` the n distinct Ed25519 public keys (64 hex) of its attesters. A set without a cap for an asset cannot back listings in that asset (`EVIDENCE_ATTESTER_SET_CAP_UNDEFINED`).

`threshold`, `size` and `attesterKeys` are validated now but not used by any check until phase 2.3, when statements are verified against them.

**Attester keys.** Each key is normalized before it is stored: 64 lowercase hex characters (a 44-byte SPKI DER encoding in hex is accepted and reduced to the raw key). It must decode to a canonical Ed25519 point of prime order; all-zero, identity, small-order and off-curve keys are refused (`EVIDENCE_ATTESTER_SET_INVALID`). The keys of one set must be distinct after normalization.

**One set per key.** Until phase 2.3 each attester key may belong to one attester set only, whatever the `sourceId` (`EVIDENCE_ATTESTER_SET_DUPLICATE`). Otherwise the same attesters could register the same source under several set ids, or under another spelling of the source URL, and multiply the cap. Until phase 2.3 this is the only cross-set rule.

**Provider subcap.** Inside a set, one provider's funded open value in an asset may not exceed `providerCapBps` of the set's cap for that asset (optional field of the set, in basis points, 1 to 10,000; default `DEFAULT_PROVIDER_CAP_BPS = 2_500`, i.e. 25%, rounded up). It stops a buyer with capital equal to the set cap from filling the whole set with orders on its own listing. A listing whose `maxValuePerContract` exceeds the provider subcap is refused at publication. The subcap binds a provider identity; it relies on identities being costly, like every per-identity limit of the Marketplace.

**Refused funding returns the deposit.** If `fundOrder()` fails because the set cap or the provider subcap is full, the buyer did nothing wrong: the reservation is closed without fault (`CANCELLED`, `closeReason: "EVIDENCE_CAP_FULL"`), the reservation deposit is returned to the buyer, and the call fails with the cap error so the client knows. Phase 2.3 adds a cap per source and a per-attester aggregate cap across all sets an attester belongs to.

The open value of a set is the sum of gross amount + gas of its **funded** orders: HELD, DELIVERED or DISPUTED. It is taken when the buyer funds the order and goes down exactly once when the order is settled or refunded. Unfunded reservations (ACCEPTED) take nothing, so reservations that are cancelled in the grace period or expire cannot fill a set's cap at no cost.

`marketplace.evidenceCaps` is a read-only view: `openValue(attesterSetId, asset)`, `providerOpenValue(attesterSetId, asset, providerId)`, `providerCap(attesterSetId, asset)` and `attesterSet(attesterSetId)`. Locking and releasing are internal to the Marketplace (an ECMAScript private field, not reachable from outside the instance).

Errors:

- `EVIDENCE_CONTRACT_CAP_EXCEEDED`: one order would lock or release more than `maxValuePerContract`.
- `EVIDENCE_ATTESTER_SET_CAP_EXCEEDED`: the set's funded open value would exceed its cap (at funding; at reservation when the set is already full).
- `EVIDENCE_PROVIDER_CAP_EXCEEDED`: the provider's funded open value in the set would exceed its subcap.
- `EVIDENCE_ATTESTER_SET_DUPLICATE`: an attester key already belongs to another set.
- `EVIDENCE_ATTESTER_SET_UNKNOWN`, `EVIDENCE_ATTESTER_SET_CAP_UNDEFINED`, `EVIDENCE_POLICY_INVALID`, `EVIDENCE_ATTESTER_SET_INVALID`: configuration errors at construction or publication.

The checks run before any value moves. Listings without `evidencePolicy` are not affected and are not capped.

Example:

```ts
const m = new DigitalServicesMarketplace({
  height: () => ledger.height,
  evidence: {
    attesterSets: [{
      attesterSetId: "swpc-3of5",
      sourceId: "https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json",
      attesterKeys: [k1, k2, k3, k4, k5], // Ed25519 public keys (hex) of the five attesters
      threshold: 3,
      size: 5,
      valueCaps: { "uep-test/teur": 50_000n },
    }],
  },
});
m.publishListing({ ...terms, asset: "uep-test/teur", evidencePolicy: { attesterSetId: "swpc-3of5", maxValuePerContract: 5_000n } }, auth);
```

## Fail closed: no evidence policy, no evidence

Today no settlement guard consumes evidence, so a listing without `evidencePolicy` is simply not capped. Phase 2.3 must keep this fail closed: **any guard or validator that consumes evidence must require the listing's `evidencePolicy`** and refuse to settle on evidence for a listing that has none. Otherwise a listing published without caps could still be settled on evidence, outside every cap above.

## Sources

Only public sources that do not need an account are considered for adapters, for example NAIF SPICE kernels, JPL Horizons and SSD, CelesTrak, NOAA SWPC and NASA DONKI. Sources that require an account are excluded. An adapter is tooling outside the state machine, and no part of UEP waits for it.

## Not decided yet

- Who can be an attester (the parties, third parties named in the contract, or UEP nodes) and how attesters are paid without a native token.
- The outcome per category when evidence does not arrive in time (depends on the open decision about the arbiter).
- Verification of statements (signatures against the set's keys, binding to the order) and the evidence records of phase 2.3.
