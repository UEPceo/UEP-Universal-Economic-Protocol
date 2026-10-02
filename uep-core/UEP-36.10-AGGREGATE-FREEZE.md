# UEP-36.10 — Aggregate Contract Freeze

## Status

**FROZEN for 36.x** — changes to domain tags or height/vote-lock rules require a new major protocol version.

## Frozen domain tags (breaking if changed)

| Tag | Value | Location |
|---|---|---|
| Semantics version | `36.10` | `uep36-aggregate-semantics.ts` |
| Aggregate object version | `36.1.1` | `uep36-digest-agg.ts` |
| Aggregate encoding prefix | `UEP36.1.1AGG` | `computeAggregateDigest` |
| Proposal domain | `UEP-36.4-AGG-PROP` | `proposalDigestFromPayload` |
| Single-batch proposal domain | `UEP-35.7.1-PROP` | `proposalDigestFromPayload` |

## Frozen rules

1. One certified transition per `(epoch, height)`.
2. Waves ≠ heights.
3. DigestAggregate binds `epoch, height, previousStateRoot, entries` (sorted by batchId).
4. Does **not** bind execution `stateRoot` inside aggregateDigest (bound in proposalDigest + vote-time check).
5. Multi-batch requires `aggregateDigest` + `batchIds`.
6. `batchIds` are sorted for proposalDigest (set canonicity).
7. When `entryDigests` present, `aggregateDigest` must match recomputation.
8. Vote lock: ≤1 proposalDigest per `(epoch, height)` per node.
9. Leader equivocation at same height → evidence; no double vote.
10. `previousStateRoot` must match local previous root at vote time.
11. Finality marks **all** `batchIds` in the aggregate.

## Fixes applied in 36.10 review

| Issue | Fix |
|---|---|
| `batchIds` order changed proposalDigest | Sort before digest |
| Tampered aggregateDigest accepted if entries present | Recompute integrity check |
| FINALITY only marked first batchId | Mark full `batchIds` list |
| Version label drift (36.7) | Pin semantics to `36.10` |

## Explicitly NOT frozen / NOT in scope

- Poseidon SMT state roots
- Production BFT under arbitrary partitions
- Disk WAL
- True concurrent execution
- Domain tags listed above (must not change without new version)

## Test gate

`npm run test:36.10` and `npm run test:36.x` (full 36.3–36.10).
