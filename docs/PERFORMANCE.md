# Performance: Poseidon BN254, SMT depth 254 and the service event loop

Testnet reference code, measured on the development container (one core, no
native code). Numbers depend on the machine; reproduce them with:

```
node --experimental-strip-types --no-warnings scripts/bench-ledger-cost.ts
```

## Measured (2026-10-08, v0.5.3)

| Measure | Node 22.23.3 | Node 24.21.0 |
|---|---|---|
| One SMT node hash `hMerkle` (two Poseidon permutations) | ~0.4–0.7 ms | ~0.45 ms |
| SMT depth 254, one `set` (new leaf, compressed trie, root) | ~100–176 ms | ~112 ms |
| `UepLedger.submit` of one single-input spend (in process) | ~440 ms | ~450 ms |
| Largest event-loop stall while submitting 6 spends, in process | ~860 ms | ~970 ms |
| Same, through `LedgerWorkerHost` + `LedgerSubmitQueue` | ~6 ms | ~29 ms |

Where the time goes: a submit updates three balance leaves and inserts one
nullifier and one note commitment. In the compressed trie a new leaf below an
empty subtree is lifted level by level to depth 254, and every level costs
one node hash (two Poseidon permutations). Empty-subtree hashes are already
cached (`emptyHashes`) and node hashes are memoized (bounded memo), so a new
leaf still costs ~254 node hashes. The 17 s figure quoted in the external
review is the uncompressed reference tree used by one test, not the ledger
path.

## What changed (v0.5.3)

- **The service event loop is no longer blocked by ledger work.**
  `LedgerWorkerHost` (`src/service/ledger-worker-host.ts`) runs the ledger on
  a `node:worker_threads` worker (no dependency); the service submits through
  a bounded `LedgerSubmitQueue`. The submit itself is as expensive as before,
  but HTTP I/O keeps being served (test:
  `src/service/ledger-worker-host.test.ts`, which also checks that the worker
  reaches the same state root as an in-process ledger).
- TypeScript arithmetic: Montgomery multiplication and fewer reductions in
  the S-box were measured at ~8 % on the Poseidon permutation; not adopted
  (marginal, and the reduction code is shared with the circuit vectors).
- Changing the tree hashing (for example shortcut leaves that skip the
  lift) would change every state root, snapshot and fixture; not done.

## Optional Wasm Poseidon (not done; residual)

A Wasm build of the in-repo Rust Poseidon (`uep-core/uep-21-poseidon`,
arkworks BN254 x5_3) would be acceptable only with a reproducible build and
the TypeScript fallback kept, plus a parity test against
`uep-core/vectors`. It was not built: the toolchain available here (rustc
1.85.1 without rustup) has no `wasm32-unknown-unknown` standard library, so
a Wasm artifact could not be built and verified reproducibly in this
environment. Plan when a pinned toolchain with the wasm32 target is
available: build `cargo build --release --target wasm32-unknown-unknown`
with the pinned `Cargo.lock`, commit the `.wasm` with its SHA-256 and the
exact toolchain, load it optionally from `src/core/poseidon.ts` (TS path
stays the default and the fallback), and add a parity test over the
committed Poseidon vectors and random inputs.
