# UEP-35.6 — Global Scale + Network Adaptation

## A) Indexed ConflictGraph
Default scheduler uses occupied read/write key sets (O(n·k)).
At 10k TX: ~87× faster than legacy all-pairs (LAB single-process).
sequential ≡ parallel commitment preserved.

## B) Data vs Consensus plane
DATA: mempool, worker, batch body, DAG, recovery.
CONSENSUS: proposal digest, CommitCert, FinalityCert (unchanged).
Workers never finalize.

## C–I) NetworkAdapt (experimental)
`src/core/uep-net-adapt/` — NetworkAdapter, StarlinkAdapter (mock/recorded),
telemetry confidence levels, RelaySelector, DTN store-and-forward sim, topology sim.

Starlink is **not** an architectural dependency.

## LAB only
Benchmarks in `benchmarks/uep35.6-bench.json` are not network TPS.
