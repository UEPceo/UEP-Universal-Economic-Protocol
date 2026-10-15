# UEP BFT consensus — implementation boundary

Status: experimental safety kernel and authenticated PeerNet transport; not production consensus. Version 0.5.80 serializes the certified commit critical section and tightens write-ahead recovery on top of the 0.5.79 transaction binding, 0.5.78 authenticated transport and 0.5.77 durable safety kernel. The legacy transaction quorum remains separate and is not silently replaced.

## Configuration target

- Byzantine fault model: at most `f` Byzantine validators.
- Validator count: `n >= 3f + 1`.
- Commit quorum: `2f + 1` distinct validators.
- Initial target: `n = 4`, `f = 1`, quorum `3`.
- Validator identities and Ed25519 public keys must be pinned in a canonical validator-set configuration. Never learn voting keys from an unauthenticated `/status` response.
- Protocol messages are bound to network ID, domain ID, height, round, phase, validator identity and block ID. Proposals also bind parent root and proposer.

## Protocol profile and safety invariants (0.5.77)

The implementation target is a **Tendermint-style, round-based BFT profile**, not a claim of conformance to the Tendermint specification or formal verification. Before deployment, the protocol rules and edge cases require an independent review against a pinned specification revision.

The following invariants are required of the kernel and every future integration:

1. **Quorum:** with `n >= 3f + 1`, a certificate counts distinct pinned validators only and requires `2f + 1` valid signatures over the same network, domain, height, round, phase and block.
2. **No equivocation:** one validator must not sign two different block IDs for the same height, round and phase; this guard must survive restart before signing is permitted.
3. **Lock before precommit:** a validator may precommit only when it has verified the matching same-round prevote certificate and has registered the corresponding lock. The durable-kernel factory persists that lock before the precommit signing API can proceed; storage failure is fail-closed.
4. **Lock monotonicity:** a lock cannot be downgraded. A conflicting block can be considered only with a valid higher-round prevote certificate and a round-change quorum that preserves the highest certified lock.
5. **Commit validity:** a commit requires a valid precommit certificate; a prevote certificate alone is never finality. Two different blocks cannot be committed at the same height.
6. **Restore validation:** imported state is validated before mutating live state. Duplicate lock entries, invalid lock certificates and lock/commit conflicts are rejected.
7. **Durability boundary:** the optional kernel persistence hook plus `BftDurableStateStore` performs write-temp, file fsync, atomic rename and directory fsync before releasing vote/round-change signatures or applying lock/commit mutations. `exportState()` by itself remains serialization only. The file checksum detects corruption but is not an authenticity mechanism against an attacker who can rewrite the file.
8. **Certified application:** the opt-in PeerNet transaction path binds `blockId` to `txId`, checks the proposed parent root and next height, verifies a precommit certificate, journals the certificate and transaction before applying the spend, serializes the critical section, and rejects conflicting journal entries at one height. Kernel commit state is recorded only after ledger application succeeds. This is crash-consistent write-ahead/replay, not a transactional storage engine spanning ledger and consensus state.

## What this code currently implements

`src/node/bft-consensus.ts` implements an experimental lock/round-change slice: validator-set sizing, deterministic round leader selection, proposal signature validation required before voting, votes with cryptographically bound justification certificates, same-height lock state backed by `2f+1` prevotes, signed round-change messages and quorum certificates, and a rule that a new-round proposal must carry the highest certified lock reported by its round-change quorum. Precommit requires a same-height/round/block prevote certificate **and** a registered matching lock; `recordCommit` only accepts a verified precommit certificate. Restore rejects duplicate lock entries and locks conflicting with a committed block. Lock state is included in the version-3 export/import shape and validated on restore. `src/node/bft-durable-store.ts` provides atomic file persistence bound to network/domain and validator-set fingerprint. The factory loads and validates stored state before returning the kernel. `npm run test:consensus-bft` runs focused tests.

## Required before calling it BFT consensus

1. Formally review the lock/valid-round and round-change rules against a named protocol specification (e.g. a Tendermint-style protocol); the current kernel is not yet a formally verified implementation.
2. **Partially implemented in 0.5.78:** authenticated, fixed-peer HTTP transport for proposal, prevote certificate, precommit vote and commit certificate. Requests are Ed25519-authenticated against the pinned voter map; kernel signatures/certificates are checked before voting or recording commit. Remaining: explicit message IDs/replay windows, hard bounds on certificate nesting and vote/round-change transport, timeout orchestration, retransmission policy and peer health isolation.
3. **Remaining:** extend durable state to timeout/round orchestration and any future signing path; test power-loss behavior on supported filesystems. The current store persists vote reservations, locks, commits and signed round-change intent before signatures or state transitions; do not sign/respond after a failed persistence operation.
4. **Partially implemented in 0.5.80:** serialized prepare/apply/commit-marker flow and replay of a certified journal. Remaining: move ledger state, journal and BFT state into one transactional durable backend, and bind certified checkpoints to height, block ID and state root. Local API acceptance is not finality.
5. Replace single-peer snapshot trust with certified checkpoints tied to height, block ID and state root, backed by a valid commit certificate and validator-set epoch.
6. Add process-level and network-fault tests: Byzantine equivocation, delayed/reordered/duplicated packets, crash/restart at each persistence boundary, partitions, stale leaders, conflicting valid-looking certificates, and deterministic convergence.
7. Independent review of the protocol specification and implementation; adversarial testing under Node 22 and 24.

## Safety boundary

`src/node/peer-net.ts` exposes opt-in `configureBftConsensus()` / `bftPropose(proposal, tx)` alongside the lower-level certificate-only path. When a transaction is supplied, `blockId` must equal `txId`; validators check the parent state and next height, verify the precommit certificate, persist a local write-ahead journal entry, then apply the transaction through `UepLedger.submit()`. The apply queue serializes journal preparation, ledger application, BFT commit recording and the durable applied marker. If a crash occurs after the ledger mutation but before the marker, replay detects the already-applied transaction and reconciles the BFT kernel without applying it twice. `recoverBftCommits()` still requires the caller to restore the matching ledger snapshot and configure BFT. This is crash-consistent recovery, not a cross-resource atomic transaction: ledger snapshot, journal and BFT kernel state are not committed in one durable transaction. The transport still lacks an inbox replay cache, explicit timeout/round-change transport, and strict nested-certificate bounds. Do not use the kernel for real funds or claim production Byzantine fault tolerance.

## Crash-consistent certified application (0.5.80)

The local journal is atomically replaced using exclusive temp-file creation, file fsync, rename and directory fsync. A record is first durable as prepared; only after `UepLedger.submit()` succeeds is the kernel commit recorded and the record marked applied. Recovery can reconcile a crash between those steps. The journal is process-local: do not share a `stateDir` between writers. This is not full storage atomicity until the ledger state, journal and BFT state share a transactional backend.

## Certified ledger application and recovery (0.5.79)

For transaction-bearing proposals, construct the proposal with `height = ledger.height + 1`, `parentRoot = ledger.stateRoot().toHex()` and `blockId = tx.txId.toHex()`, then call `await net.bftPropose(proposal, tx)`. Validators reject a transaction whose ID does not match the block ID or whose parent root/height differs from local state. A verified precommit certificate is written with the transaction into `bft-commit-journal.json` (when `stateDir` is configured) before `UepLedger.submit()` is called. After restoring a matching pre-commit ledger snapshot and configuring the kernel, call `await net.recoverBftCommits()` to replay the local journal. This journal is a recovery aid, not a substitute for a durable transactional ledger or certified checkpoint sync.

## Authenticated transport usage (0.5.78)

For a validator already running `PeerNet`, instantiate the BFT kernel with the canonical pinned validator list and the same `networkId`/`domainId`, then call `net.configureBftConsensus(kernel)`. Ensure `PeerNet.id` and its Ed25519 identity key match that validator entry, and configure `peers` with the fixed validator endpoints. The current orchestration starts at round 0: the designated leader calls `bftPropose({ networkId, domainId, height, round: 0, proposerId, parentRoot, blockId })`. It collects `2f+1` prevotes, persists/observes the lock, collects `2f+1` precommits and propagates the resulting commit certificate. Without the optional `tx` argument this returns a certificate only. With `tx`, the transaction is applied locally and on peers only after a verified commit certificate; all validators must begin from the same parent root. A failed quorum or missing acknowledgements fails closed.

The BFT HTTP endpoints are `/bft/proposal`, `/bft/prevote-certificate` and `/bft/commit-certificate`; all require the existing pinned-validator Ed25519 transport authentication. BFT must remain opt-in; do not infer that legacy `/tx`, `/vote`, `/commit` have become BFT-finalized.

## Durable store usage (0.5.77)

Use `createDurableBftConsensusKernel(domain, validators, faultTolerance, statePath)` for the experimental durable path. The factory validates the stored envelope and restores the full BFT state before returning a kernel. Do not construct a plain `BftConsensusKernel` and assume that `exportState()` is durable. Keep the state path on a local filesystem with atomic rename/fsync semantics and protect the host and directory; the checksum is for corruption detection, not adversarial authenticity. The current format is BFT state v3 and intentionally rejects older state shapes instead of silently dropping round-change anti-equivocation records.

The store currently covers local vote reservations, certified locks, commit records and round-change signing intent. It does not persist a complete timeout scheduler, authenticated peer inbox/outbox, or ledger state. The separate PeerNet commit journal introduced in 0.5.79 and hardened in 0.5.80 records certified transaction payloads, but the journal and ledger snapshot are not one atomic durable store. It is therefore not a complete node recovery system.


## Vote binding, locks and round change: written rules (0.5.81)

These are the rules the kernel (`src/node/bft-consensus.ts`) enforces. They are written down and tested; they are
**not** machine-checked (no TLA+/model-checker proof yet).

- **B1 Vote binding.** A vote signs `uep-bft-vote-v2:` + canonical JSON of network, domain, **epoch**, **validator-set
  hash** (sorted ids and keys plus `f`), height, round, phase, voter, block and the **proposal core hash**
  (`uep-bft-proposal-core-v1`: domain, epoch, validator set, height, round, proposer, parent root, block). A vote of
  another epoch or validator-set configuration does not verify.
- **B2 Certificates.** A certificate counts only votes that sign the same proposal core; votes for two cores never add up.
  A precommit's justification is a prevote certificate for the same core.
- **L1 Anti-equivocation.** Per (height, round, phase, validator) the kernel remembers the proposal core hash and persists
  it **before** releasing the signature; a failed write means no signature. A different core at the same position is
  `BFT_EQUIVOCATION`, also after restart.
- **L2 Lock before precommit.** A valid 2f+1 prevote certificate becomes the lock for the height and is persisted before
  any precommit can be signed; precommit requires the registered lock for the same round and block.
- **L3 Unlock.** A locked validator prevotes another block only with a prevote certificate (POL) from a round higher than
  its lock (`validRound > lockedRound`).
- **R1 Round change.** A round-change message names the sender's lock and its certificate, is signed, persisted before
  release and refused for a target round not above the lock. A proposal for round > 0 needs a 2f+1 round-change
  certificate and must carry the highest certified lock it contains; conflicting locks at the same round are refused.
- **C1 Commit.** A precommit certificate is finality for the kernel; the ledger counts a height as applied only through
  `applyCertifiedCommit` (ADR 0007).

Tests: `src/node/bft-consensus.test.ts`, `src/node/bft-binding.test.ts` (`npm run test:consensus`).
