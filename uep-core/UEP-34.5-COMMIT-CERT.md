# UEP-34.5 — Commit certificates & proposal/vote boards

## Problem closed (experimental room)

| ID | Without 34.5 | With 34.5 |
|---|---|---|
| E9 | Isolated replicas apply different seq=1 roots | `ProposalBoard` first-wins; second digest → `LEADER_EQUIVOCATION` |
| E4 | Two QCs for same epoch both verify | `VoteBoard` locks `(voter, epoch)` → digest; second → `VOTE_EQUIVOCATION` |

## Components

- `ProposalBoard` — shared proposal registry (lab stand-in for gossip)
- `CommitCert` — ≥ quorum Ed25519 votes on proposal digest before apply
- `VoteBoard` — dissemination lock for NewLeader QC votes
- `bootCommitLab` — commit → failover → commit path

## Still LAB

- Board is in-process shared memory (not multi-host gossip yet)
- Not a full prepare/precommit/commit pipeline for TX batches
- Not partition theorem complete without network-layer dissemination

## Tests

```bash
npm run test:34   # includes 34.5 + experimental room
```
