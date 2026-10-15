# ADR 0007 — Certified commit: one idempotent transition between a BFT certificate and the ledger (0.5.81)

Status: accepted (experimental BFT path; single-process evidence only)

## Context
A BFT precommit certificate means "validators decided block B at height H". Before 0.5.81 the node applied the
transaction and recorded the kernel commit in separate steps around a rewritten JSON journal. That left room for
three failure modes (user finding H1): double application, partial state, and a certificate counted as a ledger
application that never happened.

## Decision
1. **Durable commit log** (`src/node/certified-commit.ts`, `CommitLog`): append-only JSON lines in
   `<stateDir>/bft-commit-log.jsonl`. Every entry carries `seq`, `type` (INTENT, APPLIED, ABORTED), height, round,
   blockId, `certHash` (SHA-256 of the canonical certificate), `preRoot`, `postRoot`, `result`, `prevHash` and its own
   `hash`. Each append is a single write followed by `fsync`; the file and directory are fsync'd at creation.
   On open the chain is verified; only a torn **last** line (no trailing newline) is truncated, anything else is
   `COMMIT_LOG_CORRUPT` and the node refuses to start.
2. **`applyCertifiedCommit({ proposal, proposalSignature, certificate, tx })`** (`CertifiedCommitter`) is the only path
   from a certificate to the ledger. In order: verify the precommit certificate (quorum, unique validators,
   signatures, justification) and the proposal signature; bind `blockId = txId`; check the expected BFT height
   (last decided height + 1) and the parent root (live ledger root and last APPLIED post-root); check no prior
   spend (tx not present, no committed nullifier, full `validateSpend`); append INTENT; `ledger.submit`; append
   APPLIED with the result; then `kernel.recordCommit`.
3. **Idempotence**: the same decided block at a decided height returns the stored result (deep-equal) and changes
   nothing. A different block at that height is `BFT_COMMIT_CONFLICT`.
4. **Distinct status**: `status(height)` is `UNKNOWN`, `CERTIFIED_NOT_APPLIED` (INTENT only, or a kernel certificate
   with no ledger transaction), `APPLIED` or `ABORTED`. Only APPLIED counts as applied. `/status` exposes
   `bftCommit.pendingNotApplied`.
5. **Recovery** (`recover()`, called by `PeerNet.recoverBftCommits()` after the operator restores a ledger snapshot):
   APPLIED heights missing from the restored ledger are re-applied in order and their roots re-checked; an INTENT
   without APPLIED is finished (roll forward: the certificate is final) if the ledger is at its pre-root or already
   has the exact tx as its head; if the tx can no longer apply, ABORTED is appended and the ledger is untouched;
   any other mismatch is `BFT_RECOVERY_DIVERGED` and the node refuses to continue.
6. **Heights** are BFT commit heights from the log (or `ledger.height` when the log is empty). No clock is read.
7. **Compatibility**: the 0.5.80 `bft-commit-journal.json` (v1) is migrated once into INTENT entries
   (`migratedFrom`) and renamed `.migrated`; recovery re-establishes their status. Ledger and Marketplace snapshot
   formats are unchanged (no format 11 is needed: the commit log is a separate file).

## Consequences
- Crash points tested: before-intent, torn intent, after-intent, after-apply, torn applied, after-applied,
  after-kernel-commit; each in the same process and after a restart from the snapshot
  (`src/node/certified-commit.test.ts`). A seeded property test (seeds 1, 7, 42, 2026, 31337) mixes replays,
  crashes and restarts and checks that no certified tx is applied twice and the final root matches a reference.
- The ledger itself is still in memory; durability of balances relies on snapshot + commit-log replay. This is
  crash-consistent single-process commit and recovery, **not** evidence about a distributed network.
- Log compaction (truncating the log below a signed snapshot) is not implemented yet.
