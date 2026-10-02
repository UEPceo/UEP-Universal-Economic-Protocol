# UEP-37.7 — Silent leader timeout + view change

## Mechanism

```
height H, view V
leader = sortedIds[(H - 1 + V) % N]

if no height progress for leaderTimeoutTicks:
  V → V+1   (SILENT_LEADER_TIMEOUT)
  new leader may propose same height H
```

When height is applied on all nodes: `V → 0`.

## API

```ts
cluster.leaderTimeoutTicks = 40; // 0 = disabled
cluster.advanceView("MANUAL" | "SILENT_LEADER_TIMEOUT")
cluster.viewChanges // audit log
cluster.leaderForNextHeight() // respects view
```

## Tests

`test:37.7` → 5/5 PASS  
`test:37.6` regression → 5/5 PASS  

## Scope

In-process MultiNodeCluster LAB. Not process-mesh view-change messages yet; not HotStuff QC view-change.


## Process mesh (37.7.1)

- `VIEW_CHANGE` over TCP
- `UEP_LEADER_TIMEOUT_MS` / `ProcessCluster.start({ leaderTimeoutMs })`
- `cmd: advance-view` + `cluster.advanceView()`
- Propose gated: `NOT_LEADER` if not scheduled

Tests: `uep37.7-process-view.test.ts` 3/3 PASS


## Updates
- **37.7.1** process mesh VIEW_CHANGE
- **37.7.2** signed ViewChangeQC (optimistic VIEW_CHANGE ignored)
