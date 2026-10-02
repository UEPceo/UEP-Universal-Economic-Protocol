# UEP-37.7.2 — Signed View-Change Quorum Certificate

## Problem

In 37.7.1 a single `VIEW_CHANGE` TCP message could optimistically move `heightView`.
A Byzantine or buggy replica could force a view rotation alone.

## Rule

**A view is adopted if and only if a `ViewChangeQC` verifies with ≥ quorum signatures.**

## Canonical target (signed)

```
UEP-37.7.2-VC|networkId|domainId|epoch|height|nextView|reason
```

Fields:

| Field | Meaning |
|---|---|
| networkId | Cluster/network identity |
| domainId | Domain |
| epoch | Consensus epoch |
| height | Next height waiting for a leader |
| nextView | Proposed view (must be localView+1) |
| reason | SILENT_LEADER_TIMEOUT \| MANUAL \| … |

## Vote & QC

- `ViewChangeVote`: `{ nodeId, targetDigest, signature }` Ed25519 over the digest.
- `ViewChangeQC`: `{ target, targetDigest, votes[] }` with distinct valid signers ∈ replica set.

## Quorum (explicit)

```
params = bftParamsFromN(N)
quorum = params.quorum
```

- If `N = 3f+1` (classic): **quorum = 2f+1** (N=4 → 3).
- Else LAB-MAJORITY: **floor(N/2)+1**.

## Wire (process mesh)

1. Timeout / `advance-view` → `requestViewChange` → broadcast `VIEW_CHANGE_VOTE`
2. Peers verify target coherence, **co-sign** same target, re-broadcast vote
3. First node to assemble quorum broadcasts `VIEW_CHANGE_QC`
4. Peers `verifyViewChangeQC` + `canAdoptViewChangeQC` → set `heightView = nextView`
5. Legacy `VIEW_CHANGE` messages are **ignored** (`REQUIRES_QC`)

## Rejection

| Condition | Result |
|---|---|
| Bad signature | drop |
| Unknown signer | drop |
| Duplicate signer | count once |
| Wrong network/domain/epoch/height | drop |
| nextView ≠ local+1 | drop |
| Votes < quorum | no QC |
| Stale nextView ≤ local | no adopt |

## Tests

- Unit: 13/13 PASS (`uep37.7.2-view-change-qc.test.ts`)
- In-process silent leader: 5/5 PASS
- Process mesh: PASS (view-changed via `VIEW_CHANGE_QC`)

## Out of scope

HotStuff prepare/pre-commit QC chain, process isolation without co-sign, cross-domain views.
