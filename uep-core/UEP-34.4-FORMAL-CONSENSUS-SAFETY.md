# UEP-34.4 — Formal consensus safety (lab)

## Closed

| Item | Mechanism |
|---|---|
| Real vote lock | `Voter.signVote` refuses second digest in same epoch |
| Double-vote evidence | `buildDoubleVoteEvidence` + `verifyDoubleVoteEvidence` |
| BFT params | `n=3f+1` → quorum `2f+1` (e.g. n=4 → 3; n=7 → 5) |
| Exact checkpoint | `continueFromSequence === lastSequence` |
| Lock persistence | `voter-lock.json` save/load |
| Quorum path uses Voters | `collectVotesFromVoters` |

## Still LAB / NOT BFT complete

- No full prepare/precommit/commit pipeline for **transaction batches**
- No formal partition theorem proof
- No async BFT under arbitrary message delay
- QC still primarily **leader change**, not TX finality certificate

## Next (strategic)

Stop endless 34.x patches → specify **finality** + optional DAG dissemination (UEP-35 research).
