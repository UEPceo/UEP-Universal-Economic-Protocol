# Unified certified-state persistence (0.5.84, item 1)

Status: Experimental (lab). Single-node storage on a local filesystem that honours `fsync` and `rename`. Not a replicated database.

## What is stored together

Before 0.5.84 a validator kept three things in separate files: the certified-commit journal (`bft-commit-log.jsonl`), the BFT safety state (`bft-kernel.json`) and, implicitly, the economic state (rebuilt from the journal). Each file was durable on its own, but there was no single atomic unit across them.

`src/node/unified-state-store.ts` keeps all of them in one write-ahead log (`uep-state.wal`) plus an atomically replaced checkpoint (`uep-state.checkpoint`):

| Record kind | Content | Written |
|---|---|---|
| `commit` | one certified-commit journal entry (INTENT / APPLIED / ABORTED), hash-chained as before | every journal append |
| `economic` | `{ height, stateRoot, txCount }` of the ledger after the apply | in the **same frame** as each APPLIED entry |
| `bft` | the kernel's safety state (votes, locks, round changes, commits) | before a vote/round-change signature is released, and in the APPLIED frame |
| `ledger-snapshot` | signed ledger snapshot (nodes holding snapshot keys) | optional |
| `checkpoint` | last certified checkpoint (item 2) | when built or accepted |
| `migrated` | names of the legacy files copied in | once |

## Frame format

```
"UEPW" | u32 payloadLength (LE) | SHA-256("uep-unified-wal-v1:" || prevHash || ":" || payload) | payload (UTF-8 JSON)
payload = { v: 1, seq, prevHash, records: [...] }
```

The WAL starts with a header line naming the store version and the context `{ networkId, domainId, validatorSetHash }`; another context is refused (`UNIFIED_STORE_CONTEXT_MISMATCH`).

- **Atomicity.** A frame is visible completely or not at all. One frame = one write + `fsync`.
- **Torn tail.** Only the last frame can be incomplete. Opening the store truncates it (also when its length is complete but its checksum fails, i.e. pages persisted out of order). The number of bytes dropped is reported (`repairedTornBytes`).
- **Corruption.** A bad checksum, bad magic or a broken `seq`/`prevHash` chain in any frame that is not the last one stops the node (`UNIFIED_STORE_CORRUPT`). There is no silent repair.
- **Compaction.** Every 512 frames (configurable) the materialized view is written to `uep-state.checkpoint` (tmp + `fsync` + rename + directory `fsync`, with its own checksum and the `(seq, hash)` of the last frame covered), then a new empty WAL replaces the old one the same way. Frames with `seq` ≤ the checkpoint's are skipped when opening, so an interruption between the two steps is harmless.
- **Idempotent recovery.** Opening the store twice gives the same view and head hash. The committer's `recover()` then finishes any INTENT without APPLIED (roll forward) or appends ABORTED, as in 0.5.81–0.5.83.

## Finality only after a durable commit

`applyCertifiedCommit()` returns a result only after the APPLIED frame (journal entry + economic head + BFT state) is `fsync`'d. Results now carry `durable: true` when that is the case. `CertifiedCommitter` takes `requireDurable: true` (set by the validator process): an in-memory journal is then refused (`BFT_COMMIT_LOG_NOT_DURABLE`), because a commit that cannot be recovered after a restart is never reported as final.

## Migration from the 0.5.83 files

`openUnifiedValidatorState()` (`src/node/unified-node-state.ts`) copies `bft-commit-log.jsonl` (hash chain verified, torn line repaired) and `bft-kernel.json` (checksum and context verified) into **one** frame, then renames them to `*.migrated`. A crash after the frame and before the renames leaves a non-empty store; the next start does not copy again and only finishes the renames. `UEP_STATE_BACKEND=legacy` keeps the 0.5.83 layout for one more release (compat shim).

## Write points tested

| Layer | Points | Test |
|---|---|---|
| Committer (journal) | before-intent, intent-torn, after-intent, after-apply, applied-torn, after-applied, after-kernel-commit | `unified-state-store.test.ts` (in-process, recovery run twice); `bft-crash-points-multiprocess.test.ts` (real SIGKILL, now on the unified store) |
| Store | frame-torn (every byte offset of the last frame), damaged middle frame, checkpoint-written, wal-reset | `unified-state-store.test.ts`; `bft-unified-store-multiprocess.test.ts` (SIGKILL mid-frame in a validator process) |
| Writer process | random SIGKILL (12 rounds) with auto-compaction every 7 frames | `unified-state-store.test.ts` (child process `unified-store-writer.fixture.ts`) |
| Migration | legacy → unified, crash between frame and rename | `unified-state-store.test.ts`; `bft-unified-store-multiprocess.test.ts` (legacy validator restarted on the unified store) |

## Limits (residual)

- Single machine, local filesystem. Behaviour on filesystems that do not honour `fsync`/directory `fsync` is not covered.
- The economic state itself is rebuilt by replaying APPLIED transactions from genesis (validators hold no snapshot signing key); the store binds the post-root in the same frame, so a divergent replay is detected, but long histories make restarts slower until snapshot-based restarts are wired.
- The Marketplace snapshot and the reference CLI node (`npm start`) still use their own files; only validator processes use the unified store in 0.5.84.
