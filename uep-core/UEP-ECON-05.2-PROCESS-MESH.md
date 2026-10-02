# ECON-05.2 Process mesh economic + partitions

## Implemented
- process-node proposals carry `economicCommitment` (tip) on propose + proposeAggregate
- voters verify tip before commit vote
- status / pollStatus expose economicTip, treasury, balances, sequence
- stdin propose parses kind / holdId / obligationId / providerId / price (BigInt)

## Tests (`test:econ-05.2-mesh`) — 4/4 PASS
1. 4-process transfer → identical stateRoot + economicTip
2. hold_open → hold_consume settle → tip convergence
3. partition 3|1 majority advances; after heal roots/tips converge
4. partition 2|2 blocks finality

## Residual
- Obligation registry still not replicated across processes (consume without DELIVERED binding uses ECON-04 compat path)
- 5|2 / 7-node process partitions not in suite
