# UEP-37.6 — Single proposer per height

## Problem (37.5 stress)

Concurrent `proposeAggregateFrom` from two leaders could leave nodes at different sequences/roots.

## Rules

1. **Scheduled leader:** `leader(height) = sortedIds[(height-1) % N]`
2. **No pipeline:** next propose only if all nodes share `sequence === globalSeq`
3. **Receive gate:** reject PROPOSAL if sender ≠ scheduled leader or `height !== localSeq+1`

## API

```ts
cluster.leaderForNextHeight()
cluster.assertProposerAllowed(nodeId)
cluster.singleLeaderPerHeight // default true
```

## Tests

`test:37.6` → 5/5 PASS (incl. concurrent dual → only h1 leader, converge)

## Scope

LAB scheduling — not full BFT view-change / HotStuff. Next: optional view-change on silent leader.
