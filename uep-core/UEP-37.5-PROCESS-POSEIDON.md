# UEP-37.5 — Process/TCP + Poseidon SMT stateRoot

## What shipped

Process mesh (4 OS processes, TCP) can run with:

```ts
await cluster.start(4, { leafMode: "poseidon-zk", smtDepth: 8 });
```

Env per child: `UEP_LEAF_MODE=poseidon-zk`, `UEP_SMT_DEPTH=8`.

`stateRoot` on each process is the **Poseidon SMT root** (via `uep-zk smt-root`), same as 37.4.

## Stress results

| Test | Result |
|---|---|
| 10 sequential aggregates in-process | PASS — one root |
| Rotating leaders sequential | PASS |
| Concurrent dual-leader | **Documented unsafe** without single-leader/BFT election |
| Insufficient funds | PASS — null propose, roots stable |
| Process mesh 3 sequential txs | PASS |
| Process propose + aggregate | PASS |

## Fix applied under stress

- `proposeAggregateFrom` catches schedule/INSUFFICIENT → `null` (no throw)
- `waitRootChange` / `waitFinalizedAtLeast` for process sequential finals

## Known limitation

Concurrent proposals from two leaders in the LAB multi-leader path can leave nodes at different sequences. **Use sequential leader rotation** until dedicated leader election binds one proposer per height.

## Tests

- `test:37.5` process: 3/3 PASS  
- `test:37.5-stress`: 5/5 PASS  
