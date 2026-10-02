# UEP-30.3 — Engine persistence

**Status:** 🟢 snapshot + journal (lab)

## Snapshot (`EngineSnapshot` v1)

- config, roots, treasury, accounts, stateLeaves, nullifiers, transitionIds, pending
- `includeSecrets: true` only for DEV recovery tests
- File API: `writeSnapshotFile` / `loadSnapshotFile`

## Journal

Append-only NDJSON: enqueue | commit | reject | snapshot markers.

## Recovery

`loadSnapshot` rebuilds `ExecutionEngine` and continues enqueue/prove/commit.

Does **not** replace a production node DB; it is the lab path to “process restart without losing state”.
