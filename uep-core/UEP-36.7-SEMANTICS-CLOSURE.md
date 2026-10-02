# UEP-36.7 — Aggregate Semantics Closure

## Frozen contract (version string `36.7`)

1. **Height** = one certified logical transition per `(epoch, height)`.
2. **Waves** do not create heights (parallel-safe scheduling only).
3. **DigestAggregate** binds `epoch | height | previousStateRoot | entries`.
   Does **not** bind post-execution `stateRoot` (verified at vote time).
4. Multi-batch proposals require `aggregateDigest` + `batchIds`.
5. **Vote lock**: at most one `proposalDigest` per `(epoch, height)` per node.
6. **Leader equivocation**: two digests at same height from same sender → evidence; honest nodes do not vote both.
7. **previousStateRoot** must match the voter's local previous root.

## Module

`src/core/uep36-aggregate-semantics.ts`

- `validateProposalSemantics`
- `HeightVoteLock`
- `ProposalTracker`
- `previousRootMatches`
- `assertAggregateDigestBinding`

## Wired into

- `uep35-multinode.ts` (PROPOSAL + tryVote)
- `uep35-process-node.ts` (PROPOSAL + tryVote)
- `proposeAggregateEquivocation` LAB attack helper

## Demonstrated

- Incomplete/malformed aggregate rejected
- Vote lock conflict recorded
- Split equivocation → no BFT finality (n=4)
- Honest aggregate still finalizes; locks agree
- Regression: sequential ≡ scheduled, 36.4–36.6 suites

## NOT YET

- Durable vote-lock across process restart
- Multi-leader × partition cross tests
- Poseidon SMT roots (v37 candidate)

LAB only. Poseidon / ZK / fee / BFT params unchanged.
