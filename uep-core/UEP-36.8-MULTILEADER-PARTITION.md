# UEP-36.8 — Multi-leader × Partition/Heal

## Scenarios

| Scenario | Result |
|---|---|
| mn-0 → mn-1 sequential aggregates | heights chain; locks h=1,h=2 agree |
| 3\|1 majority finalize → heal → mn-1 height 2 | all honest same root |
| Process/TCP same path | converge after heal + second leader |

## Guarantees (LAB)

- Rotating leaders do not fork state when vote-lock + BFT quorum hold.
- After partition heal, a *different* leader can advance the next height.
- Vote locks for finalized heights remain consistent across honest nodes.

## NOT production

Still single-host process mesh / in-process sim. No durable disk WAL yet (see 36.9 soft-restart).
