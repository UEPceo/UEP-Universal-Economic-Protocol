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
| `maxValuePerContract` | `evidencePolicy` of a listing, declared at publication; part of the signed listing terms; immutable | none: required for an evidence-bound listing; must be > 0 and ≤ the set's cap for the listing asset | at `reserve()` (gross amount + gas of the order) and again at settlement |
| `valueCaps[asset]` | `AttesterSetPolicy` in the Marketplace config (`evidence.attesterSets`) | no attester sets are configured, so no listing can be bound to evidence | at `reserve()`: open value of the set in that asset + the new order ≤ cap |

An attester set is `{ attesterSetId, threshold: k, size: n, valueCaps }` with 1 ≤ k ≤ n. A set without a cap for an asset cannot back listings in that asset (`EVIDENCE_ATTESTER_SET_CAP_UNDEFINED`).

The open value of a set is the sum of gross amount + gas of its orders that are reserved, funded or delivered and not yet closed. It goes down exactly once when the order is settled, refunded, cancelled or expires.

Errors:

- `EVIDENCE_CONTRACT_CAP_EXCEEDED`: one order would lock or release more than `maxValuePerContract`.
- `EVIDENCE_ATTESTER_SET_CAP_EXCEEDED`: the set's open value would exceed its cap.
- `EVIDENCE_ATTESTER_SET_UNKNOWN`, `EVIDENCE_ATTESTER_SET_CAP_UNDEFINED`, `EVIDENCE_POLICY_INVALID`, `EVIDENCE_ATTESTER_SET_INVALID`: configuration errors at construction or publication.

The checks run before any value moves. Listings without `evidencePolicy` are not affected and are not capped.

Example:

```ts
const m = new DigitalServicesMarketplace({
  height: () => ledger.height,
  evidence: { attesterSets: [{ attesterSetId: "swpc-3of5", threshold: 3, size: 5, valueCaps: { "uep-test/teur": 50_000n } }] },
});
m.publishListing({ ...terms, asset: "uep-test/teur", evidencePolicy: { attesterSetId: "swpc-3of5", maxValuePerContract: 5_000n } }, auth);
```

## Sources

Only public sources that do not need an account are considered for adapters, for example NAIF SPICE kernels, JPL Horizons and SSD, CelesTrak, NOAA SWPC and NASA DONKI. Sources that require an account are excluded. An adapter is tooling outside the state machine, and no part of UEP waits for it.

## Not decided yet

- Who can be an attester (the parties, third parties named in the contract, or UEP nodes) and how attesters are paid without a native token.
- The outcome per category when evidence does not arrive in time (depends on the arbiter decision D-5).
- Verification of statements (signatures against the set's keys, binding to the order) and the evidence records of phase 2.3.
