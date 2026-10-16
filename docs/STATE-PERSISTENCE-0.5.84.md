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

## BFT store continuity checks (0.5.84, internal review 2026-10-16)

A validator's refusal to sign two conflicting votes lives in its local safety state. Starting with that state missing, or from an older copy, while keeping the same signing key is now refused. Code: `src/node/bft-store-continuity.ts`, wired into the unified store (`unified-node-state.ts`), the legacy store (`bft-durable-store.ts`), PeerNet and `bft-validator-process.ts`.

| Check | Behaviour | Error |
|---|---|---|
| A. Missing store | A validator does not start without its store. Exceptions: `UEP_BFT_STORE_INIT=genesis`, the first start of a new identity (allowed only when no anchor exists), and `UEP_BFT_REJOIN=retire`, an explicit re-key/rejoin where the identity starts watch-only, never signs again, and is marked retired in its anchor. Coming back needs a new key and a validator-set change. | `BFT_STORE_MISSING` |
| B. Monotonic sequence and hash chain | Every durable write has a `stateSeq` and the hash of the previous write. Unified store: frame seq plus the SHA-256 frame chain. Legacy store: format 2, `stateSeq` and `prevChecksum`. A secondary anchor holds the last accepted `(seq, hash)`. It is `<stateDir>.bft-anchor.json` by default, outside the state directory; `UEP_BFT_ANCHOR_PATH` moves it, preferably to another device. A store below the anchor, or at the anchor's seq with another hash, is refused. | `BFT_STORE_STALE` |
| C. Peer attestation | After each durable frame the validator signs `(validatorId, stateSeq, stateHash)` with Ed25519 (prefix `uep-bft-state-attest-v1:`). It sends this to its peers (`POST /bft/state-attest`), which keep the highest one per validator (`bft-peer-attestations.json`). At start the validator asks its peers (`GET /bft/state-attest`) and signs nothing until 2f peers have answered. If a verified attestation is newer than its local state, signing stays suspended and it must rejoin. | `BFT_STORE_STALE` |

**Compat.** A format-1 legacy store, or a unified/legacy directory written before 0.5.84, has no anchor. It is accepted once, then anchored at its current position. Format-1 files load as seq 0 and are rewritten as format 2 on the next write. A genesis start writes a first `init` frame at once, so a crash before the first vote still leaves a store. Downgrading to a binary older than 0.5.84 after that frame exists is not supported.

**Tests:**
- `src/node/bft-store-continuity.test.ts` covers A, B, C, compat, and EXP-104 (SIGKILL between fsync and rename on both backends: no signature leaves the process without a durable record).
- `src/node/bft-store-continuity-multiprocess.test.ts` runs 4 validator processes with one Byzantine validator, plus a separate scenario for the peer check.

**Residual:**
- These are local, cooperative checks. They do not cover an operator who restores the store and the anchor together while every honest peer that answers also missed the newest attestations. That can happen when a partition hid those attestations and the Byzantine peer withholds its own. Closing that gap needs a trusted monotonic counter (TEE or hardware), which is out of scope.
- Attestations are sent after the frame is durable, so a short window remains in which peers have not yet seen the newest one.
- A modified binary ignores all of this; the Byzantine validator in the tests is modelled with the test-only switch `UEP_TEST_BYZANTINE_STATELESS=1`.
- The peer check runs on the unified backend only. The legacy backend (`UEP_STATE_BACKEND=legacy`) gets A and B.
- Rotating a key back in needs a validator-set change; epochs are fixed in 0.5.84.
