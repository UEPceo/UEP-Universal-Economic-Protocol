## 0.5.84 — 2026-10-16

Durability, validator synchronization, formal model of the locking rules and production conditions. Draft; not merged or released without the maintainer's go-ahead. Resolution matrix: [`docs/audit/0.5.84-RESOLUTION.md`](docs/audit/0.5.84-RESOLUTION.md). Protocol fee 0.1 %, Marketplace fee 3 %, no native token, Poseidon BN254 unchanged, time from block height, no new runtime dependency.

- **Unified certified-state persistence.** `src/node/unified-state-store.ts`: one write-ahead log (`uep-state.wal`, frames with length, SHA-256 chained checksum, `fsync` per frame) plus an atomically replaced checkpoint (`uep-state.checkpoint`) for the certified-commit journal, the BFT safety state and the economic head. The APPLIED journal entry, the post-apply `{height, stateRoot, txCount}` and the BFT state are written in one frame. Torn last frame truncated at open; damage anywhere else stops the node. Auto-compaction every 512 frames, safe to interrupt. Results carry `durable: true`; `requireDurable` refuses an in-memory journal (no finality without a durable commit). Validator processes use it by default; `UEP_STATE_BACKEND=legacy` keeps the 0.5.83 files. One-time, idempotent migration of `bft-commit-log.jsonl` and `bft-kernel.json` (`src/node/unified-node-state.ts`). Design: [`docs/STATE-PERSISTENCE-0.5.84.md`](docs/STATE-PERSISTENCE-0.5.84.md).
- **BFT store continuity checks.** A validator refuses to start without its store (`BFT_STORE_MISSING`) unless it is an explicit first start (`UEP_BFT_STORE_INIT=genesis`, only without an anchor) or an explicit re-key/rejoin (`UEP_BFT_REJOIN=retire`: watch-only, never signs again). Every durable write carries a monotonic `stateSeq` and the previous hash; an anchor outside the state directory keeps the last accepted position, and an older or forked store is refused (`BFT_STORE_STALE`). Validators sign their store position to peers (`/bft/state-attest`, Ed25519) and do not sign until 2f peers answered; a newer peer attestation keeps signing suspended. Legacy store format 2 (`stateSeq`, `prevChecksum`); format-1 and pre-0.5.84 stores are anchored once. New module `src/node/bft-store-continuity.ts`; tests incl. 4 processes with one Byzantine validator and SIGKILL between fsync and rename. Residual items in `docs/STATE-PERSISTENCE-0.5.84.md`.
- **Certified checkpoints.** `src/node/certified-checkpoint.ts`: `{networkId, domainId, height, blockId, stateRoot, validatorSetHash, txCount, ledgerHeight}` signed by 2f + 1 validators; a validator signs only its own journaled head (`/bft/checkpoint-sign`). Snapshot acceptance rejects stale, incompatible, conflicting and uncertified snapshots (`PeerNet.requireCertifiedCheckpoint`). Checkpoints persist in the unified store. [`docs/CERTIFIED-CHECKPOINTS-0.5.84.md`](docs/CERTIFIED-CHECKPOINTS-0.5.84.md).
- **TLA+ model.** `docs/formal/tla/UepBftLocking.tla` (locking, round changes, proposal selection; n = 4 with a Byzantine leader), TLC outputs committed, negative control without durability shows the Agreement violation. Mapping to Tendermint (arXiv:1807.04938) with QBFT-style round changes, deviations listed: [`docs/formal/BFT-SPEC-MAPPING.md`](docs/formal/BFT-SPEC-MAPPING.md).
- **Production conditions (heights approved by the director on 2026-10-16).** `config/production-conditions.json` + `src/network/production-conditions.ts`: v1 signature sunset per network type (lab relative, testnet absolute height 3 153 600, mainnet refused), asset registry mandatory by network type and height (`requiredFromHeight`, honoured by `assertRegistryPolicy`). Governance key-ceremony procedure and public-only tooling (`scripts/governance-ceremony.mjs`, no key generated): [`docs/GOVERNANCE-KEY-CEREMONY.md`](docs/GOVERNANCE-KEY-CEREMONY.md), [`docs/PRODUCTION-CONDITIONS.md`](docs/PRODUCTION-CONDITIONS.md).
- **Type check.** `tsc --noEmit` errors 95 → 0 (type-only changes, plus `NullifierSet.size`, which `pendingGeneration()` read as `undefined`, and `ledger-worker` reading the public `height`). The type check is now a blocking step inside the required `Node 22.x` / `Node 24.x` jobs.
- **CI.** Multi-process adversarial suites in both Node jobs; seeded property runs and labs on Node 22 and 24; depth-64 ZK end-to-end test (`UEP_ZK_D64=1`) blocking in the labs jobs; evidence records tied to the commit SHA uploaded as artifacts (`scripts/run-evidence.mjs`, now with dirty-tree flag).
- **Compat.** `UEP_STATE_BACKEND=legacy`; legacy files migrated once and kept as `*.migrated`; `CommitLog` file mode unchanged; `NetworkRegistryPolicy.requiredFromHeight` optional; `UepServiceApi` accepts structural provider types (the lab classes still fit).

## 0.5.83 — 2026-10-15

Spend circuit liveness fix (circuit v6). Poseidon BN254 unchanged; arkworks only, no new dependencies.

- New circuit tag `UEP-27-SPEND-POSEIDON-D64-v6-rotblind`: tree depth 64 (fits the u64 slot indices), note blinding rotated in-circuit on every spend (`H(D_BLIND=7, secret, nonce)`), receiving slots may be empty. Same fold and public-input order as v5 (13 inputs, domain_id at 12). 278,503 constraints at depth 64; on 8 cores prove 6.9 s vs 3.7 s for v5 at depth 32 (setup 7.1 s, verify 3 ms, proving key 60 MB).
- v5 (`UEP-27-SPEND-POSEIDON-D32-v5-foldv2`) is kept byte-identical: v5 pins unchanged, historical v5 transactions re-verify on restore; new v5 submissions need `zkAcceptLegacyV5: true`. Helper migration `migrate_state_d32_to_d64` / `migrate_nullifiers_d32_to_d64` (Rust, with tests).
- Ledger: v6 payloads carry `senderNextBlinding`; the depth-64 projection keeps per-slot blindings, rebuilt from committed transactions on restore (no snapshot format change). PI[11] is checked against the circuit commitment of the proof's publics and PI[12] against the ledger domain. `zkRootBinding` now defaults to `"circuit-projection"`; `"off"` stays available for labs and is refused under NODE_ENV=production.
- Witness contract: Poseidon witnesses get the tree checks with the Poseidon backend, plus index-bit checks.
- `uep-zk`: `circuit_version` in spend requests (default 5), `dev-vk-v6 <4|64>`, `bench-v6 <depth>`; pin script covers v6.
- zk accounts: id `H_ACCOUNT(secret, salt)` linked to the Ed25519 account by a signed link (`linkZkAccount`, optional `zkLinks` in the snapshot, re-verified on restore; older snapshots unchanged). A zk account spend has no notes and no signature: the v6 proof authorizes it and its PI[10] is the transaction nullifier. Existing accounts move funds with a signed transfer to their zk account. `zkCircuitDepthV6` option (64, or 4 for labs). Lab network profile now names circuit v6 at depth 64.
- Exit path: a zk account can pay an Ed25519 account; the recipient gets its balance and a deterministic exit note (`zkExitNote`) it spends with its own signature. Real-proof tests for acceptance, replay, wrong recipient, tampered amount, substituted note and supply conservation. Opt-in depth-64 end-to-end test (`UEP_ZK_D64=1`), record in `docs/audit/evidence-0.5.83/zk-d64-e2e-node24.json`.
- `uep-zk prove-spend-json`: `domain_fr` (ledger domain as a field element), `sender_new_blinding` in the output, leaf indices accepted as strings; v5 requests with empty slots are refused.
- Tests: Rust spec predicate `spend_valid` with differential tests both ways, mutation sweep, nightly `#[ignore]` perturbation probe with positive control; TS ledger v6 tests and real Groth16 proof tests (depth 4), including an end-to-end zk account spend accepted by the ledger with replay and reused-nullifier rejection.

External source adapters requested by Research (reports UEP-RR-2026-10-08-001 and UEP-RR-2026-10-15-002). All off-node in `scripts/adapters/`; no state transition, snapshot format or signed format changes. With every source down, every node behaves exactly as before. No price enters state. Protocol fee 0.1 %, Marketplace fee 3 %, no native token.

- `scripts/adapters/lib.mjs`: hard timeout, non-200 = unavailable, strict UTF-8/JSON, NFC without trimming or case folding, BigInt decimal scaling (no float on values).
- Seismic (phase 2.3 preparation): `seismic.mjs`, `usgs-seismic.mjs` (USGS, public domain), `geofon-seismic.mjs` (GEOFON, CC BY 4.0, attribution required). Each emits the 0.5.82 canonical SEISMIC claim and `claimHash` for attesters. Cross-source tolerances remain residual (30-day study); `compareSources()` reports `SOURCES_DISCREPANT` or refuses with `EVIDENCE_TOLERANCES_UNSET`. Not wired to settlement.
- Lab only, behind `UEP_LAB_SOURCES=1`: NOAA SWPC Kp and F10.7, JPL Horizons, CelesTrak, NASA DSN Now, Open-Meteo (non-commercial only).
- Not added: EMSC (written permission needed), IANA/IERS leap-second files (waiting for the exporter), discarded sources.
- Docs: sources table with licence, attribution and account requirement in `docs/ORACLE.md`; `docs/EVIDENCE.md`; README module table and `docs/MODULES.md` section 22.
- Removed: the World Bank display-only indicator added in 0.5.82 (`src/service/indicative-display.ts`, `/v1/display/indicators`), by director decision. UEP does not use the World Bank API. Compat: the old `WORLDBANK` id is still accepted by `displayIndicative()` and answers "no disponible" without any request (test in `indicative-display.test.ts`). No persisted field or config key was involved.
- Tests: `npm run test:adapters` (11 tests, recorded fixtures, network disabled), in `test:core`: normalization, claim output, lab flag, malformed data, timeouts, down sources and discrepant sources.


### 0.5.83 — Blocks A–E (director requirements)

Resolution matrix with evidence and dispositions: [`docs/audit/0.5.83-RESOLUTION.md`](docs/audit/0.5.83-RESOLUTION.md). Results of the sequential runs (commands, seeds, Node versions, outputs, SHA-256): [`docs/audit/evidence-0.5.83/`](docs/audit/evidence-0.5.83/). Protocol fee 0.1 %, Marketplace fee 3 %, no native token, Poseidon BN254 unchanged, no new dependency.

- **A — signatures bound to network and domain.** New signed payload v2 (`src/marketplace/signature-v2.ts`) for Marketplace actions, reservations and IoT telemetry: `networkId`, `domainId` (Marketplace id), signer, nonce, operation type, ids, details (amounts, hashes) and a height window `[validFromHeight, validUntilHeight]` (max 17,280 heights). The verifier rebuilds the message from its own network and domain. Nonces are single-use per signer until the window closes and are persisted in the Marketplace snapshot (pre-0.5.83 snapshots migrate to an empty registry). Legacy v1 only through `legacyV1Signatures: { sunsetHeight }` (one deprecation warning, refused from the sunset height); under `NODE_ENV=production` v1 is refused unless configured explicitly. Client helpers: `signActionV2`, `signReservationV2`, `envelopeV2`, SDK `newSignatureNonce()`. Tests: `src/marketplace/signature-v2.test.ts` (other network, other domain, other nonce, other operation context, window, nonce reuse, restart, IoT v2).
- **B — BFT finality and recovery.** Leader equivocation is detected from relayed signed proposals, recorded as self-verifying evidence (`src/node/bft-equivocation.ts`, persisted `bft-equivocation-evidence.jsonl`), gossiped, and triggers an immediate round change; validator processes run an internal height-tick timer and the next leader re-proposes automatically (identical proposal on retry, never a second block per round). Tests: `src/node/bft-equivocation.test.ts`; multi-process `src/node/bft-recovery-multiprocess.test.ts` (4 OS processes, seeded per-link loss/delay/duplication/partition, SIGKILL + restart, crashed leader, equivocating leader).
- **C — crash points.** SIGKILL (kill -9) in real validator processes at each of the 7 commit write points (`UEP_CRASH_AT`), restart, recovery twice with identical result, audit of hash chain, consecutive heights, ledger/APPLIED order, root chain and state root. Test: `src/node/bft-crash-points-multiprocess.test.ts`.
- **D — asset manifest governance.** `src/node/asset-registry-store.ts`: persistent, versioned, governance-verified manifest chain (`asset-registry.json`, chain hash, atomic writes, migration from the pre-0.5.83 layout, rollback refusal). Network policy `requireAssetRegistry`: `assembleNode` and the CLI (`UEP_REGISTRY_POLICY`) refuse to operate without the registry (`NODE_REFUSES_TO_OPERATE`). The ledger snapshot keeps binding `{networkId, version, hash}`. Test keys only; no key ceremony was generated.
- **E — evidence.** `scripts/run-evidence.mjs` runs suites one at a time and records outputs and hashes; `run-seeded.mjs` includes the Block B and C multi-process tests (first three seeds); `npm run test:bft-adversarial`.
- Sources: GEOFON attribution updated (event products CC BY 4.0; waveforms not used); CelesTrak adapter follows the usage policy (OMM JSON only, one download per 2-hour update, hard stop on any non-200); NASA DSN documented as CC0 unless noted (logos excluded).

## 0.5.82 — 2026-10-15

Triage of the external "Aegis-Orbit" static report on v0.5.81 (`AUDIT-MV990F9F-LUPO`; summary [`docs/audit/AUDIT-EXTERNA-2026-10-15-AEGIS.md`](docs/audit/AUDIT-EXTERNA-2026-10-15-AEGIS.md), matrix [`docs/audit/0.5.82-RESOLUTION.md`](docs/audit/0.5.82-RESOLUTION.md)). Protocol fee 0.1 %, Marketplace fee 3 %, no native token, Poseidon BN254 unchanged.

- Identifiers, nonces, trace ids and temp dirs outside tests use `node:crypto` (`randomBytes`, `mkdtempSync`) instead of `Math.random`.
- Agent simulation ranking uses an integer-scaled `qualityScore()` (bigint) instead of a float.
- Explicit no-underflow checks: ledger prepare (`FEE_UNDERFLOW`), `checkSpendShape` (positive amount, non-negative fee), `quoteSettlement` (`FEE_EXCEEDS_GROSS`). Rust witness fixtures use `checked_sub`; new circuit test shows amount = 1, fee = 2 over a balance of 2 is unsatisfiable (`enforce_u64`).
- Regression tests `src/testnet/aegis-0582.test.ts` (nullifier reuse, amount = 1 / fee = 2, fee ≤ gross, integer score).
- `.gitleaks.toml` allowlist for the RFC 9180 HPKE test vectors and the `test-only-objects-token` fixture.
- Open: network-ID binding of marketplace reservation/action and IoT telemetry signatures (signed-format change, not made here).
- External sources (Research): evidence statements v2 bound to the local network (`UEP-EVIDENCE-STATEMENT-v2`, v1 only for archives); observation height bounds and signed `maxAgeHeights`; signed `onNoEvidence` / `evidenceDeadlineHeight` with `resolveNoEvidence()`; canonical claim and distinct-source-set structure (tolerances residual); off-node `scripts/adapters/` with `check:adapters`; display-only ECB/BIS/Eurostat/World Bank figures (`GET /v1/display/indicators`). No snapshot format change.
- Tests: new regression files `src/testnet/aegis-0582.test.ts` and `src/marketplace/evidence-0582.test.ts`; `test:all` passed on Node 22 and 24 before release.

## 0.5.81 — 2026-10-15

Security and recovery work on the user's v0.5.80 findings (resolution matrix: [`docs/audit/0.5.81-RESOLUTION.md`](docs/audit/0.5.81-RESOLUTION.md)). Protocol fee 0.1 %, Marketplace fee 3 %, no native token, Poseidon BN254 unchanged.

- **H1 — certified commit (ADR 0007).** `src/node/certified-commit.ts`: append-only, fsync'd, hash-chained commit log (`bft-commit-log.jsonl`) and a single idempotent `applyCertifiedCommit()` (certificate, expected height, parent root, prior spend, INTENT → apply → APPLIED → kernel commit). Same certificate returns the stored result with no second balance change; another block at a decided height is `BFT_COMMIT_CONFLICT`; `CERTIFIED_NOT_APPLIED` is a distinct, visible status. Recovery finishes or aborts each pending height deterministically. PeerNet uses it for every certified ledger application; the 0.5.80 JSON journal is migrated once. Tests: `src/node/certified-commit.test.ts` (crash injection at 7 write points × 2 restart modes, replay, conflict, height, prior spend, invalid certificate, tamper, divergence, migration, seeded property test), in `test:consensus`.
- **Item 2 — vote binding.** Votes (and the anti-equivocation record) now sign epoch, validator-set hash and the proposal core hash (parent root, proposer, position, block); certificates carry `proposalHash` and never mix cores; precommit justification must match the core. Round-change messages carry the epoch. Written rules B1–C1 in `docs/CONSENSUS-BFT-ROADMAP.md`. Not wire-compatible with 0.5.80 validators (experimental path). Tests: `src/node/bft-binding.test.ts`.
- **Item 3 — multi-process consensus harness.** `src/node/bft-validator-process.ts` runs one validator per OS process; `src/node/bft-multiprocess.test.ts` drives four of them through seeded per-link fault proxies (loss, delay/reorder, duplication, partition), a SIGKILL restart, a spent-tx proposal and an equivocating proposer, asserting no conflicting finality and honest convergence. Commit messages now carry the signed proposal and transaction; `GET /bft/commits` and `PeerNet.bftSync()` let a lagging validator catch up, re-verifying everything. Round-change timers are still not automatic (liveness after equivocation is open).
- **Item 4 — snapshot restore rules.** `PeerNet.catchUp` restores peer snapshots with a height floor and then requires history continuity (`extendsHistory`: same transactions in order, no fewer mints, every BFT-applied transaction present). Written restore trust rules in `docs/COMPATIBILITY.md`. Tests: `src/node/snapshot-rules.test.ts` (in `test:node`).

- Item 5 (partial): each APPLIED certified commit records the asset-registry {version, hash}; a later commit under no registry, an older version or a different manifest at the same version fails with BFT_REGISTRY_REGRESSION before anything is written. Tests: src/node/registry-binding.test.ts. The reference node still runs without a registry by default.

- Item 6 (partial): marketplace order state machine written as data (src/marketplace/order-state-machine.ts: phases HOLD/EVIDENCE/SETTLEMENT/CLOSED, transition table). Every status write is checked (ORDER_TRANSITION_INVALID); SETTLED/REFUNDED are checked before value moves and require the settlement-engine receipt hash (SETTLEMENT_RECEIPT_REQUIRED).

- Item 7 (partial): src/lab/zk-binding-0581.test.ts mutates each of the 13 Groth16 public inputs (all refused), mutates each tx-binding field (all refused), recomputes the Rust transaction_commitment with the TS hFoldV2 (cross-check), and pins a reproducible public-input vector (src/lab/fixtures/zk-binding-0581-vector.json). Circuit and VK versioning stay on the existing circuit tag + VK pins; DEV keys stay behind zk-dev-keys-guard.

- Item 8 (partial): src/core/amount.ts (parseAmount, parseDecimalUnits, addU64/subU64). Amounts crossing a trust boundary are u64 integers: negative, NaN, Infinity, floats, exponents, hex, signs, leading zeros and > u64 are refused (AMOUNT_INVALID/AMOUNT_OUT_OF_RANGE); decimal input with too many digits is refused, not rounded. Wired into note deserialization, snapshot balances (INVALID_SNAPSHOT_AMOUNT), HTTP amount/price/capacity/quantity fields, the Groth16 spend queue, service backends and the value bridge.

- Item 9 (partial): src/node/peer-envelope.ts. PeerNet now sends v2 envelopes signed over {network, domain, epoch, sender, path, height, nonce, payload hash}; receivers refuse other networks/domains/epochs, envelopes older than 64 heights, and repeated nonces (409 PEER_REPLAY). v1 envelopes are still accepted for 0.5.80 peers with a one-time UEP_DEP_PEER_ENVELOPE_V1 warning, and refused once ledger.height >= legacyEnvelopeUntilHeight. Server limits: 256 connections, 64 in-flight requests (503 BUSY), header/request/keep-alive timeouts; the 2 MiB body cap and per-IP rate limit stay. PeerKeyRegistry: key rotation needs the old key plus a validator quorum, revocation needs a validator quorum; both are height-scoped and sequence-checked.

- Item 10 (partial): test classes written down in docs/TEST-SUITES.md. npm run test:security (critical security set) runs as a named blocking CI step; npm run test:property(:full) runs the seeded property, fuzz and multi-process fault suites over a fixed seed list in a new blocking CI job and uploads a JSON record (seeds, Node version, platform, commit, per-run results, reproduce command). New seeded parseAmount fuzz (20,000 strings).

- Item 2 follow-up (compatibility): `BftKernelOptions.voteV3ActivationHeight`. Below that height 0.5.81 signs and verifies 0.5.80 (v2) votes, certificates and round changes unchanged, so 0.5.80 and 0.5.81 validators interoperate; from it on only v3. Tested against a frozen copy of the 0.5.80 kernel. Default 0 (v3 everywhere): set the height to upgrade a running 0.5.80 cluster. v3 votes sign with the `uep-bft-vote-v3` tag.
- Item 3 follow-up: deterministic, height-based round-change timeout (`src/node/bft-round-timer.ts`, `PeerNet.bftTick`, `POST /bft/round-change`, `bftProposeAfterRoundChange`). A height opened by an equivocating proposer now closes in a later round.
- Item 4 follow-up: own persisted height floor outside BFT mode (`src/node/height-floor.ts`); the CLI and PeerNet refuse to run on a ledger below it (`LEDGER_BELOW_HEIGHT_FLOOR`, `LEDGER_ROOT_AT_FLOOR_MISMATCH`), with a logged `UEP_ALLOW_HEIGHT_REGRESSION=1` override.
- Item 5: the registry binding is not made the reference-node default in 0.5.81 (needs persistent governance keys and a snapshot migration; see the resolution matrix).
- Dependencies: the 5 low-severity Dependabot alerts (Rust `tracing-subscriber` < 0.3.20, pulled in by `ark-relations` 0.3 in the lab crates) are not fixed by a patch/minor bump: `ark-relations` 0.3 requires `tracing-subscriber` ^0.2, and moving to arkworks 0.4+ changes the circuit and its verifying keys. No npm runtime dependencies; `npm audit` reports 0.

- Fixes found by the full suite: peer retries re-sign the envelope (new nonce) so a retry after a lost reply is not refused as a replay (the multi-process fault test caught this); the envelope freshness window is measured against the highest height accepted from that sender, not the receiver's height (lagging peers can still talk); on catch-up the height floor checks the height only, since a peer may hold more transactions at the same height and history continuity is checked separately.

- Tests (local, sequential, Node 22.23.3 and Node 24.21.0, identical counts): protocol 219, marketplace 223, settlement 20, oracle 38, category 24, consensus 107, node 18, poisoned clock 446, labs 564 (127 files), all passing; Rust crates, smoke, quickstart and 20k simulation pass. CI: Node 22, Node 24, labs and seeded property/fault jobs green; type check (non-blocking) still reports pre-existing errors as on 0.5.80.

## 0.5.80 — 2026-10-13

- Tightened the BFT commit critical section: journal preparation, ledger application, kernel commit recording, and applied-marker persistence are serialized through the same application queue.
- The write-ahead record is persisted before ledger mutation; the BFT kernel records the commit only after the exact transaction is present in the ledger. Recovery reconciles a crash after ledger application but before the kernel commit/applied marker, without applying the transaction twice.
- Journal replacement uses exclusive temporary-file creation, file `fsync`, atomic rename, and directory `fsync`; malformed journal records are rejected at startup.
- This is crash-consistent single-process commit/recovery, not a true cross-database atomic transaction: the ledger remains in-memory unless the operator persists/restores snapshots, and multiple processes must not share this local journal.
- No change to snapshot format 10, protocol fee 0.1%, Marketplace fee 3%, or the no-native-token policy.
- Integration fixes (repository release of 0.5.80):
  - ZK development verifying-key pins for circuit `UEP-27-SPEND-POSEIDON-D32-v5-foldv2` (depths 4 and 32, domain 1) added to `uep-core/vectors/UEP-ZK-DEV-VK-PINS.json`. The circuit tag changed in 0.5.5 but the pin file still listed only v4, so every pinned verification in the lab failed with `VK_NOT_PINNED` (ZK, P4/BFT mesh, spend queue and quorum lab suites). Pinning and domain binding stay strict; the v4 pins are kept. The pins were generated with the new `scripts/gen-zk-dev-vk-pins.mjs` from `uep-zk dev-vk` (public fixed seed `DEV_SETUP_SEED`, development keys, no ceremony, no secret). `npm run check:zk-pins` (in `test:all`) fails when the built circuit tag has no pin.
  - `src/lab/uep-network-profile.ts` names the current circuit tag; the UEP-37.2 golden test expects it.
  - Six node and SDK test files that no script ran (`sdk/cli.test.ts`, `src/node/{bridge-api,categories-oracle,node-e2e,paymaster-ledger,persist}.test.ts`) now run in `test:core` as `npm run test:node`.
  - README version line, status table and module table; `docs/MODULES.md` (reference node / BFT kernel / PeerNet, SDK, configuration and examples); ROADMAP, BUG-BOUNTY, REPRODUCIBILITY and PHASE-4-ASSESSMENT headers updated to 0.5.80.
  - `src/service/ledger-worker-host.test.ts` (event-loop gap under 150 ms) is timing-sensitive and failed once on a heavily loaded machine; it passed in isolation and on a quiet machine. The threshold is unchanged.
- Test counts for this tree (`npm run test:all`, Node.js 22.23.3 and 24.21.0, identical on both, 0 failed, 0 skipped): protocol 214, Marketplace 220, settlement 20, oracle 38, category 24, consensus 66, node 6, poisoned-clock 446, Rust 127; lab 126 files, 561 tests. v0.5.3 (CI): protocol 199, Marketplace 210, settlement 19, oracle 37, category 23, poisoned-clock 425, Rust 127; lab 116 files, 546 tests.

## 0.5.79 — 2026-10-13

- BFT proposals can now bind a transaction by requiring `blockId === tx.txId` and matching the local parent root and next ledger height.
- A verified precommit certificate drives `UepLedger.submit()` on the proposer and participating validators; the old certificate-only `bftPropose(proposal)` mode remains available for kernel/transport testing.
- Added local write-ahead `bft-commit-journal.json`: certified proposal, certificate and transaction are persisted before ledger mutation; `recoverBftCommits()` replays entries after restoring the matching ledger snapshot and configuring BFT.
- Added a four-validator integration assertion that all ledger roots converge after certified application, plus restart/replay coverage from the pre-commit snapshot.
- Recovery boundary remains explicit: ledger snapshot and BFT journal are not one atomic durable transaction; recovery must be invoked by the operator, and certified checkpoint sync/timeouts/replay-cache hardening remain open.
- No changes to snapshot format 10, protocol fee 0.1%, Marketplace fee 3%, or the no-native-token policy.

## 0.5.78 — 2026-10-13

- Connected the experimental BFT kernel to the fixed-peer authenticated HTTP transport as an opt-in path.
- Added proposal intake, prevote certificate validation/locking, precommit collection, commit-certificate verification and propagation.
- Requires validator identity keys to match the pinned voter set and the BFT domain to match the local ledger domain.
- Added a four-validator integration test for the proposal → prevote QC → precommit QC → commit certificate path.
- Explicit boundary: BFT commit certificates are recorded in the kernel but are not yet atomically applied to the ledger; the legacy transaction quorum remains unchanged.
- No change to snapshot format 10, 0.1% protocol fee, 3% Marketplace fee, or no-native-token policy.

## 0.5.77 — 2026-10-13

Persistencia durable y recuperación del núcleo BFT experimental. Sin cambios en las reglas económicas, fees (protocolo 0,1 %, Marketplace 3 %) ni formato de snapshot del ledger (10).

- Añadido `src/node/bft-durable-store.ts`: almacén local con escritura temporal, `fsync` del archivo, `rename` atómico y `fsync` del directorio; permisos restrictivos en el archivo y directorio creados.
- El estado persistido queda ligado a `networkId`, `domainId` y huella del conjunto de validadores; checksum SHA-256 para detectar corrupción accidental. El checksum no se presenta como protección frente a un atacante con capacidad de reescribir el archivo.
- Votos anti-equivocación, locks certificados y commits se escriben antes de que la API de firma o mutación los haga efectivos. Los fallos de persistencia son fail-closed.
- El estado pasa a formato BFT v3 e incluye intención de cambio de ronda para impedir firmar declaraciones de lock contradictorias tras reinicio.
- Añadida fábrica `createDurableBftConsensusKernel(...)`, que valida y restaura el estado antes de devolver el kernel.
- Pruebas de reinicio, anti-equivocación, lock durable, cambio de ronda conflictivo, corrupción, cambio de conjunto de validadores y fallo de escritura.
- El núcleo sigue experimental, no conectado a PeerNet ni a la aplicación atómica del ledger. El almacén es local y de un solo proceso; no afirmar consenso BFT de producción.

## 0.5.76 — 2026-10-13

Primer endurecimiento de la máquina de estados BFT experimental. Sin cambios en reglas económicas, fees (protocolo 0,1 %, Marketplace 3 %) ni formato de snapshot (10).

- `createVote(..., "precommit", ...)` ahora exige que el certificado de prevote válido esté registrado como lock actual de la misma altura, ronda y bloque; un certificado presentado sin transición previa se rechaza.
- La restauración rechaza entradas duplicadas de lock, certificados de lock incoherentes y locks que contradicen un bloque ya registrado como committed; las validaciones se completan antes de reemplazar el estado activo.
- Añadidas pruebas negativas para precommit sin lock, importación de locks duplicados, conflicto lock/commit y metadatos inconsistentes.
- Documentadas las invariantes de seguridad, el perfil objetivo Tendermint-style (sin afirmar conformidad formal) y los límites de `exportState()`/`recordCommit()`.
- `npm run test:consensus-bft`: validación pendiente de ejecución final en este paquete.
- **Sigue siendo experimental y no está conectado a PeerNet ni al ledger.** No incluye persistencia durable/fsync; no usar para valor real ni afirmar BFT de producción.

## 0.5.75 — 2026-10-11

Primer cierre del diseño de locks y cambio de ronda del núcleo BFT experimental. Sin cambios en las reglas económicas, fees (protocolo 0,1 %, Marketplace 3 %) ni snapshot formato 10.

- Añadido bloqueo por altura respaldado por certificado de prevote `2f+1`; una propuesta conflictiva no puede sustituir el lock sin un certificado válido de una ronda superior.
- Añadido `BftRoundChange` firmado, certificado de cambio de ronda con quórum y selección del mayor lock certificado para restringir la propuesta de la nueva ronda.
- Propuestas de ronda > 0 requieren certificado de cambio de ronda; si existe un lock en el quórum, la propuesta debe conservar el bloque y el valid-round certificados.
- Votos incluyen una justificación criptográficamente vinculada; precommit exige certificado de prevote de la misma altura/ronda/bloque. `createVote` exige y verifica firma válida del líder.
- El estado exportado/importado pasa a versión 2 e incluye locks; se verifica el certificado al restaurar. `recordCommit` rechaza certificados que no sean de precommit.
- Pruebas BFT enfocadas: 13/13; suite de consenso completa: 57/57 en Node.js 22.16.0.
- **Sigue siendo un núcleo experimental no conectado a PeerNet.** No se ha implementado persistencia durable/fsync, temporizadores/transporte, integración atómica con ledger ni revisión formal independiente. No afirmar todavía BFT completo ni usar para valor real.

## 0.5.74 — 2026-10-11

Inicio de la transición a consenso BFT con una capa de seguridad experimental, sin sustituir silenciosamente el harness multinodo anterior. Fees sin cambios (protocolo 0,1 %, Marketplace 3 %); snapshots siguen en formato 10.

- Añadido `src/node/bft-consensus.ts`: validación de conjunto de validadores `n >= 3f+1`, quórum `2f+1`, líder determinista por altura/round, propuestas firmadas que incluyen raíz anterior y digest de bloque, votos ligados a red/dominio/altura/round/fase/validador/bloque, prevención de doble voto dentro de la misma ronda/fase y certificados de precommit.
- Añadidas siete pruebas enfocadas de BFT y `npm run test:consensus-bft`.
- Añadido `config/consensus-bft.example.json` como configuración de diseño para cuatro validadores, tolerancia `f=1` y quórum 3; usa claves de marcador y no debe arrancarse tal cual.
- Añadido `docs/CONSENSUS-BFT-ROADMAP.md` que delimita lo implementado y bloqueos obligatorios: bloqueo seguro y cambio de ronda, persistencia atómica durable, transporte autenticado, aplicación atómica al ledger y checkpoints certificados.
- `npm run test:consensus`: 51/51 pasa en Node.js 22.16.0.
- **No es todavía consenso BFT completo ni está conectado a PeerNet.** El harness de tres nodos y su configuración permanecen intactos para evitar dar una falsa garantía de seguridad.

## 0.5.73 — 2026-10-11

Corrección de integración de las pruebas de consenso y documentación de validación. No cambia reglas económicas, formato de snapshot ni semántica de transacciones. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios.

- Las peticiones de prueba a `/propose` incluyen `Content-Type: application/json`, como exige el servidor desde 0.5.72.
- La prueba de autenticación sin firma incluye JSON válido y comprueba específicamente `401 PEER_AUTH`; una prueba separada comprueba `415 UNSUPPORTED_MEDIA_TYPE` cuando falta el Content-Type.
- `npm run test:consensus`: 44/44; `npm run test:protocol`: 214/214; `npm run test:marketplace`: 220/220; settlement 20/20; oracle 38/38; category 24/24 pasan en Node.js 22.16.0.
- El test sintético de 20k usuarios se separa del glob unitario y queda accesible mediante `npm run test:scale`; `test:core` ejecuta consenso de forma explícita.
- La guía de reproducibilidad ya no presenta los conteos históricos de 0.5.3 como resultados actuales.
- **No es consenso de producción.** No se han cerrado en este cambio los bloqueos arquitectónicos documentados: recuperación que confía en un único par anclado, ausencia de consenso bizantino/view change, y API local que puede aceptar transacciones sin quórum.

## 0.5.72 — 2026-10-11

Más endurecimiento de seguridad para nodos públicos. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Cabeceras de seguridad en todas las respuestas del peer server: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Solo se aceptan GET y POST. Otros métodos → `METHOD_NOT_ALLOWED` (405).
- POST exige `Content-Type: application/json`. Otro → `UNSUPPORTED_MEDIA_TYPE` (415).
- Fallos de `PEER_AUTH` se registran en consola (from, path, ip).
- El estado de quorum (`quorum-votes.json`) se firma con la clave de votante del nodo. Al cargar se verifica la firma; un archivo manipulado se ignora. El formato antiguo sin firma se acepta una vez y se reescribe firmado.
- No es consenso de producción.

## 0.5.71 — 2026-10-11

Monitoring básico y proceso de bug bounty / assessment para Fase 5. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `GET /status` ahora incluye `version`, `startedAt`, `uptimeMs`, `peerCount`, `threshold` y contadores de rate-limit.
- Nuevo `docs/BUG-BOUNTY.md`: alcance, fuera de alcance, guía de severidad, canal de reporte y qué espera una evaluación independiente.
- El harness de consenso sigue siendo el mismo. No es consenso de producción.

## 0.5.70 — 2026-10-11

Hardening de seguridad para el arranque de Fase 5. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El servidor de peers limita el cuerpo de las peticiones POST a 2 MiB. Un cuerpo mayor se rechaza con `PAYLOAD_TOO_LARGE` (HTTP 413) 
- Rate-limiting básico por dirección IP: 120 peticiones por ventana de 60 s. Exceso → `RATE_LIMITED` (HTTP 429).
- El API principal (`uep-http-api`) ya tenía límite de cuerpo; el servidor de peers no. Esta es la brecha cerrada para nodos públicos.
- No es consenso de producción. `npm run test:consensus` sigue siendo el harness.

## 0.5.69 — 2026-10-10

Del arnés al nodo real. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Un par no vota un gasto que su libro rechazaría. Antes `/tx` y `propose` votaban sin validar y el voto no se libera: un gasto inválido con el anulador de otro hacía fallar el gasto legítimo con `QUORUM_EQUIVOCATION`. Ahora `UepLedger.validateSpend` (solo lectura) corre antes del voto.
- `peers.json` admite `snapshotPublicKeyHex` y `faucetPublicKeyHex` por par. `npm start` confía en las claves de snapshot y de faucet ancladas ahí, además de las suyas, tanto al reabrir el disco como en `catchUp`. Sin ancla no hay confianza: un par no puede anunciar su propia autoridad. Antes `catchUp` entre nodos reales siempre devolvía falso, porque cada nodo firma con su propia clave y confiaba solo en la local.
- `cli.ts` hace `catchUp` antes de ensamblar el nodo, así que la API, la cola, el puente y el Marketplace sirven el libro que se conservó. Antes `Object.assign` cambiaba solo la propiedad y el resto seguía con el libro viejo. `PeerNet.ledger` deja de ser `readonly` (`TS2540`).
- Prueba con tres procesos reales (`cluster-process.test.ts`): un nodo que arranca tarde no se pone al día sin anclas y sí con ellas.
- `npm run test:consensus`: 40 en verde. El libro aún acepta un voto de un solo par firmante (umbral 1): `catchUp` confía en el par que sirve el snapshot. No es la evaluación independiente. `tsc` sigue sin bloquear: quedan unos 180 errores de tipo fuera de `src/node`.


## 0.5.68 — 2026-10-10

Lectura pública. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `GET /txs` no pide firma. Devuelve altura, raíz, cuenta y los últimos veinte identificadores. No devuelve aperturas.


## 0.5.67 — 2026-10-10

Autoevaluación y arranque de Fase 5. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `npm run test:consensus`: 32 en verde. No es la evaluación independiente.
- `docs/ONBOARDING.md` es la entrada pública. `npm start` imprime la clave para anclarla.


## 0.5.66 — 2026-10-10

Nota de sesión que no evalúa el arnés. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- No corrió `test:consensus`. Repite que no es consenso de producción. No cambia el protocolo.


## 0.5.65 — 2026-10-10

Nota de evaluación inválida. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- La sesión que no extrajo el zip no evalúa el arnés. Queda registrada como inválida.


## 0.5.64 — 2026-10-10

Paquete para la evaluación independiente. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `docs/PHASE-4-ASSESSMENT.md` dice lo que el arnés afirma y lo que no. `npm run test:consensus` es el comando. No es la evaluación.


## 0.5.63 — 2026-10-10

Configuración local distinta. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Tres nodos con distinta cuenta de fee, admin y dominio de cegado aceptan el mismo gasto y llegan a la misma raíz.


## 0.5.62 — 2026-10-10

El libro local aplica después de la red. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El proponente aplica solo cuando `umbral - 1` pares confirman el commit. Si no, el libro local no toma el gasto.


## 0.5.61 — 2026-10-10

El commit tiene que llegar. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `propose` no da el gasto por aplicado si menos de `umbral - 1` pares confirman el commit. Eso es `COMMIT_NOT_ACKED`.


## 0.5.60 — 2026-10-10

Puesta al día a prueba de fallo. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Si el snapshot del par no restaura, `catchUp` devuelve falso y conserva el libro local. El arranque no cae.


## 0.5.59 — 2026-10-10

Disposición de la auditoría 0.5.58. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `/vote` persiste. `confirmed` se guarda con el voto. El ADR ya no contradice el aprendizaje de claves ni el timeout.


## 0.5.58 — 2026-10-10

Clave de votante anclada. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Una clave ya autorizada no se sustituye por `/status`. Si la lista trae `publicKeyHex`, esa es la ancla.


## 0.5.57 — 2026-10-10

Voto ligado al dominio. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El voto firma red y dominio. Un voto de otro dominio no confirma. El quórum se queda en el dominio.


## 0.5.56 — 2026-10-10

Partición y vuelta. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Dos pares confirman mientras el tercero está cerrado. Al volver, desde un snapshot anterior, llega a la misma raíz. No mezcla.


## 0.5.55 — 2026-10-10

Mensajes de pares firmados. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `/tx`, `/vote` y `/commit` llevan firma. Se comprueba contra la clave aprendida de ese id. Sin firma es `PEER_AUTH`. `/status` sigue sin firma para poder aprender la clave.


## 0.5.54 — 2026-10-10

Más gastos a la vez. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- La aplicación cede el turno entre gastos. Un voto o un commit perdido se reintenta. 8, 16, 24, 32, 48 y 64 convergen. Antes 16 rompía.


## 0.5.53 — 2026-10-10

Hito de concurrencia. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- En un proceso, tres pares: 2, 4 y 8 convergen. 12 es inestable. 16 rompe con `QUORUM_NOT_MET` y raíces distintas. No es un doble gasto. Es el arnés, no tres máquinas.


## 0.5.52 — 2026-10-10

El quórum recuerda el voto. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Los votos se guardan en `quorum-votes.json`. Un proceso nuevo los carga y rechaza un segundo voto del mismo anulador. Si el libro ya lo confirmó, tampoco vota.


## 0.5.51 — 2026-10-10

catchUp no retrocede. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Solo restaura de un par que va por delante: más altura, o la misma altura con más transacciones. Una raíz distinta que va por detrás se ignora.


## 0.5.50 — 2026-10-10

Censura hasta la ventana. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Un gasto que no consigue dos votos no bloquea la nota. Pasada la ventana, el cliente la gasta de otra forma. El gasto retenido se rechaza.


## 0.5.49 — 2026-10-10

Reloj movido. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Un nodo con `Date.now` clavado en 0 acepta el mismo gasto y llega a la misma raíz. La validez es la altura y el gasto firmado, no el reloj de pared.


## 0.5.48 — 2026-10-10

Doble liquidación. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Liquidar dos veces devuelve el mismo registro y no mueve saldos. Un Marketplace restaurado conserva el recibo y los saldos. Es local al dominio, no un recibo entre dominios.


## 0.5.47 — 2026-10-10

Puesta al día por raíz, y repetición. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `catchUp` compara raíces, no alturas. Si difieren, restaura el snapshot y sustituye el libro. No mezcla un fork. Repetir un gasto es `QUORUM_NULLIFIER_SPENT`. `npm run test:net` corre el arnés.


## 0.5.46 — 2026-10-10

Disposición de la auditoría de la red de tres. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Timeout de pares a 5 s. learnPeers no acepta un id que no esté en la lista. catchUp restaura. El anulador se marca después de aplicar. El threshold se lee del archivo.


## 0.5.45 — 2026-10-10

Menos espera en el voto. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El gasto y el voto van en una sola petición. Se confirma con dos votos, sin esperar al tercero. Confirmar y aplicar es un paso.


## 0.5.44 — 2026-10-10

Dos gastos a la vez. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Los votos de notas distintas viajan en paralelo. La aplicación va en cola, una cada vez. Dos gastos de la misma nota no confirman los dos.


## 0.5.43 — 2026-10-10

El voto sale del test y entra en `npm start`. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Con `UEP_NODE_ID` y `UEP_PEERS` el nodo abre el puerto de pares, guarda su clave y lee las otras en `/status`. `UEP_PORT` separa la API.


## 0.5.42 — 2026-10-10

Lista fija y disenso. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `config/peers.json` tiene tres direcciones y umbral 2. No hay descubrimiento. Un nodo que propone el otro gasto de la misma nota no consigue dos votos.


## 0.5.41 — 2026-10-10

Tres nodos por HTTP. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Lista fija, sin descubrimiento. Anuncian altura y raíz, se pasan el gasto y confirman con dos votos. Un nodo callado se salta. Uno solo no confirma. El atrasado pide el snapshot.


## 0.5.40 — 2026-10-10

Rotación de la clave de faucet. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `rotateFaucetKey` cambia la clave del siguiente mint. Un snapshot con mints de las dos claves solo restaura si la confianza lista las dos. Quitar la vieja rechaza el mint viejo.


## 0.5.39 — 2026-10-10

Rotación de la clave de snapshot. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `rotateSnapshotSigners` cambia la clave del siguiente snapshot. El anterior sigue válido con la clave que lo firmó. La clave vieja no firma el siguiente.


## 0.5.38 — 2026-10-10

Arnés de siete nodos. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `3f+1` con `f = 2`. Cinco votos confirman. Dos en disenso no. Los siete aplican el gasto confirmado y comparten la raíz. Sigue siendo un proceso.


## 0.5.37 — 2026-10-10

El quórum se aplica en el arnés. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Tres nodos aplican un gasto solo tras dos votos. El gasto en conflicto no llega al umbral y las tres raíces coinciden. Sigue siendo un proceso.


## 0.5.36 — 2026-10-10

Quórum del arnés. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Una transacción se confirma con el umbral de firmas distintas. Un votante firma como mucho un gasto por anulador. No es el BFT del laboratorio y no corre entre nodos.


## 0.5.35 — 2026-10-10

Recuperación por snapshot. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Un nodo atrasado restaura el snapshot firmado del nodo que va delante y llega a la misma raíz y altura. No hay líder. No mezcla un fork.


## 0.5.34 — 2026-10-10

Arnés de dos nodos: conflicto y repetición. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El mismo gasto da la misma raíz. Dos gastos de la misma nota divergen. La repetición es `REPLAY` y el otro gasto, una vez gastada la nota, es `DOUBLE_SPEND`.


## 0.5.33 — 2026-10-10

Apertura de la Fase 4. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- ADR 0006 fija qué se replica: el ledger UEP-25. El Marketplace, el puente y los laboratorios quedan fuera.
- Dos nodos restaurados del mismo snapshot aceptan el mismo gasto firmado por el cliente y llegan a la misma raíz. No hay líder ni quórum.


## 0.5.32 — 2026-10-10

Disposición de VULN-UEP-08/09. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El texto se guarda en `docs/audit/`. No se implementa: no hay `releaseCollateral`, ni token sintético, ni cegado por `Date.now()`.


## 0.5.31 — 2026-10-10

Cierra lo que la nota de la 0.5.29 dejó abierto. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El blinding por defecto del nodo sale de un hash del dominio, el contador y el tag. Con dominio 0 se conserva la fórmula histórica.
- Con `UEP_DATA_DIR` el nodo guarda claves, dominio y snapshots firmados, y al arrancar reabre el ledger y el Marketplace. Los secretos se escriben en modo 0600.
- `GET /v1/categories` publica swap, relay, dispute y drip. Las acciones firmadas de cada categoría siguen en el nodo.


## 0.5.30 — 2026-10-10

Cierre de ingeniería de la nota sobre la 0.5.29. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El depósito acredita solo si el comprador firma el id de la transacción y su identidad es la dirección del emisor. `POST /v1/bridge/claim` recupera un gasto que entró por la ruta genérica.
- La retirada firma semilla, nonce y caducidad. El nonce se guarda y no se repite.
- El barrido de gas comprueba la custodia antes de gastar y baja la deuda por lo que sale.
- El tope de identidades sale del núcleo y queda en la ruta HTTP. El seq del bus es monótono y `GET /v1/events` acepta `after` y `limit`.
- `categoryContracts` y los enunciados de evidencia entran en el snapshot. El valor del oráculo tiene que ser un entero no negativo. La clave del árbitro queda en el nodo.


## 0.5.29 — 2026-10-10

Categorías en el nodo y alimento del oráculo. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El nodo instancia swap, relay, dispute y drip sobre los puertos del Marketplace. El árbitro es una identidad registrada, no el administrador.
- `POST /v1/oracle/quotes` lo firma el administrador. La lectura sigue diciendo que no liquida.


## 0.5.28 — 2026-10-10

Depósito y retirada en la API local y en el SDK. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `GET /v1/bridge/info` publica la dirección de custodia. `POST /v1/bridge/deposit` aplica un gasto que el cliente ya firmó y acredita solo la nota que recibió la custodia. `POST /v1/bridge/withdraw` exige la firma del comprador y debita monto más fee.
- `recover` busca el tx por el id de verdad. Un id inventado sigue sin acreditar.


## 0.5.27 — 2026-10-10

Arreglos de la nota sobre la 0.5.26. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- La retirada debita monto más fee de protocolo al que retira. `reconcile` exige que la custodia cubra la deuda del puente. `recover` rechaza un txId que el ledger no tiene.
- Las categorías de siempre aceptan el nombre en minúsculas sin cambiar la firma. La suite de evidencia adjunta el enunciado antes de liquidar.
- El alta por HTTP exige una firma de posesión. Hay un tope de 256 identidades. El bus de eventos corta a 1.024 y tiene `GET /v1/events`.
- El disco recarga el índice y borra los bytes. Con `UEP_DATA_DIR` el nodo guarda las mnemotécnicas de custodia y fee.
- `audit:surface` incluye `test:marketplace`.


## 0.5.26 — 2026-10-09

Superficie para la auditoría externa de la Fase 3. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `docs/audit/PHASE-3-SURFACE.md` dice qué correr y qué no se afirma. `npm run audit:surface` encadena sandbox, escenarios y el servicio de ejemplo.


## 0.5.25 — 2026-10-09

Fase 3, CLI de desarrollador. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `npm run cli -- height` y `listings` leen la API local. No importan el libro.


## 0.5.24 — 2026-10-09

Fase 3, servicio de ejemplo. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `examples/sample-service.ts` publica, reserva, fondea, entrega y liquida solo con el SDK. `npm run example:service` lo comprueba contra la API local.


## 0.5.23 — 2026-10-09

Disposición de la auditoría recibida y apertura de la Fase 3. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El texto y la disposición están en `docs/audit/`. No se acepta el apto para producción. No se añade una malla de nullifiers ni un token.
- Política de compatibilidad de la API local en `docs/API-COMPATIBILITY.md`. Plantilla de servicio en `examples/service-template.ts`, solo con el SDK.


## 0.5.22 — 2026-10-09

Fase 2.10, simuladores. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Tres escenarios con semilla fija: proveedor, adversario y caída de máquina. Repiten el mismo resultado. Valor y capacidad quedan conservados. `npm run simulate:scenario` termina en `SCENARIO OK`.


## 0.5.21 — 2026-10-09

Fase 2.9, sandbox de un comando. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `npm run sandbox` levanta el nodo local, el Marketplace y el servicio IoT, y cierra un pedido de ejemplo. La última línea es `SANDBOX OK`. Guía en `docs/SANDBOX.md`.
- `npm run sandbox:serve` deja el nodo en `127.0.0.1:8787`.


## 0.5.20 — 2026-10-09

Fase 2.8, SDK. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `sdk/client`, `sdk/marketplace` y `sdk/iot-m2m`. El ejemplo del README y `npm run test:sdk` completan un pedido por la API local. El cliente no llama al Marketplace.


## 0.5.19 — 2026-10-09

Fase 2.7, pasarela IoT. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `IoTGateway` valida el esquema, encola si el transporte cae y reintenta por número de intentos, no por reloj. El id de telemetría sigue siendo la clave de entrega: un reintento no liquida dos veces.


## 0.5.18 — 2026-10-09

Fase 2.6, API local. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- `POST /v1/marketplace/identities` registra una clave pública. `POST /v1/marketplace/credits` acredita con la firma del administrador.
- Un comprador y un proveedor completan alta, crédito, anuncio, reserva, fondeo, entrega y liquidación solo por HTTP.


## 0.5.17 — 2026-10-09

Segunda nota de auditoría y Fase 2.5. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- El texto recibido está en `docs/audit/AUDIT-EXTERNA-2026-10-09-b.md`. No se crea el motor `uep-settlement`. El bus y la evidencia que pide ya estaban.
- Una identidad tiene tipo (human, machine, service, provider, node) y estado (active, suspended, revoked). Suspendida o revocada no firma una acción nueva. El administrador firma `identity-status`.


## 0.5.16 — 2026-10-09

Fase 2.4, contrato de categoría. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot de ledger en formato 10.

- Una categoría nueva se registra con esquema de entrada, esquema de salida, requisitos y SLA en alturas. El Marketplace no gana un caso. Las cinco de siempre siguen dadas de alta.
- Revisión de estructura: el nodo no importa UEP-37. Relay y oracle del nodo son los adaptadores reales. Consta en `docs/NETWORK-STRUCTURE-0.5.16.md`.


## 0.5.15 — 2026-10-09

Fase 2.3, evidencia. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Snapshot del ledger en formato 10. El snapshot del Marketplace sigue en formato 4; un snapshot anterior sin enunciados restaura el mapa vacío.

- Un pedido con política de evidencia no liquida sin un enunciado k-de-n ligado a ese pedido. El enunciado certifica el hash, no la verdad del dato. Los bytes no se guardan.
- La espera de conjunción usa el `delayHeights` que ya tenía el anuncio. No hay parámetro nuevo.


## 0.5.14 — 2026-10-09

Fase 2.2, almacenamiento. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Formato de snapshot 10. El snapshot del Marketplace sigue en formato 4.

- El restore rechaza un snapshot cuya capacidad no cuadra: disponible + reservado + consumido tiene que ser la capacidad del anuncio.
- `DiskStorageProvider` guarda el cuerpo en disco. El registro que puede entrar en un snapshot lleva el hash, no los bytes. No es estado de consenso.


## 0.5.13 — 2026-10-09

Informe de auditoría externa y disposición. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Formato de snapshot 10.

- Texto recibido en `docs/audit/AUDIT-EXTERNA-2026-10-09.md`. Disposición en `docs/audit/AUDIT-EXTERNA-DISPOSICION.md`. No se crea un segundo motor de liquidación ni un split de tesorería.
- El tope de 4.096 recibos por ancla ya estaba. No se olvida un nonce: reabriría el replay.
- Fase 2.1: la telemetría IoT y su liquidación emiten un evento cada una. La repetición no duplica.


## 0.5.12 — 2026-10-09

Paquete de auditoría de la 0.5.11 y primer entregable de la Fase 2. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Formato de snapshot 10.

- A1: `ValueBridge.recover` repite el crédito o el débito de un movimiento cuyo ledger ya se aplicó, sin segunda nota.
- Fase 2.1: bus en proceso. Un pedido emite un evento por transición (`accepted`, `held`, `delivered`, `settled`) y la repetición no duplica. El id es hash de tipo, pedido y altura. No entra en el snapshot.
- La evaluación externa no se declara hecha. El paquete está en `docs/audit/AUDIT-v0.5.11.md`.


## 0.5.11 — 2026-10-09

Cierre de ingeniería de la Fase 1. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Formato de snapshot 10.

- Un ledger de nodo rechaza el MAC de desarrollo. Los tests que aún lo ejercen pasan `testOnlyAllowDevelopmentMac`. Quickstart y smoke siguen en firma de emisor.
- Criterio externo que no se declara hecho: una evaluación independiente sin hallazgos críticos o altos nuevos. Consta en `docs/PHASE-1-CLOSE.md`.


## 0.5.10 — 2026-10-09

Nodo de referencia y puente de valor. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Formato de snapshot 10. Estado canónico: UEP-25 (ADR 0005). UEP-37 sigue en laboratorio.

- `src/node/assemble.ts` junta ledger, productor de altura, Marketplace, cola, serializador y HTTP. `npm start` lo arranca. El circuito de gasto se comprueba al arrancar por su tag.
- Depósito y retiro entre una nota y un saldo del Marketplace. El ancla de recibos la llama el nodo. El gas capturado por el paymaster se gasta desde la custodia.
- Un agente solo contrata dentro de su concesión; el pedido lo firma el titular. `/v1/relay` y `/v1/oracle` usan los módulos reales, no el stub de laboratorio.
- `wallet-migration` se exporta. Los cinco registros de benchmark tienen consumidor (`npm run bench:lab`).


## 0.5.9 — 2026-10-09

Filtro LEI local y consulta GLEIF solo de pantalla. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Formato de snapshot 10. El LEI no entra en política, quote ni estado.

- `isValidLei` rechaza los pares de control 00, 01 y 99, que ISO 7064 MOD 97-10 no genera, además del resto 1. Sigue sin red.
- `GET /v1/display/lei` muestra nombre legal, estado de registro y fecha de consulta. Si GLEIF no responde, la página sigue con la suma offline. No escribe estado.


# Changelog

## 0.5.8 — 2026-10-09

Parche de seguimiento de 0.5.7, compromiso de nota aportado por el cliente, y plan de retirada del MAC de desarrollo. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Formato de snapshot 10.

- El índice `ordersByBuyer` no se persiste: se reconstruye al restaurar. El test de versión acepta cualquier semver numérico, no un pin a 0.5.3.
- La API HTTP acepta el tamaño de objeto anunciado en PUT y compute, devuelve 400 en decimal o JSON inválido, y puede registrar el error interno por id sin devolverlo.
- I1: `faucet`, `prepareIssuerMint` y `mintWithIssuerSignatures` exigen la apertura del cliente. La reserva ya no guarda `blindingHex`. Dos réplicas con la misma apertura registran la misma nota. El gasto local puede seguir poniendo la apertura en la transacción; la réplica aplica esa transacción y no inventa el compromiso.
- Fase 1: plan de retirada del MAC de desarrollo en `docs/DEV-MAC-RETIREMENT.md`. El MAC no se apaga en esta release.


## 0.5.7 — 2026-10-09

Constancia de la auditoría técnica de v0.5.6 y cierre de los hallazgos confirmados de prioridad P0. Fee de protocolo 0,1 % y fee de Marketplace 3 % sin cambios. Formato de snapshot 10.

- C1: las reservas vivas de mint cuentan contra `supplyCap`, y el apply repite tope, mintable y saldo. Test `src/testnet/ledger-mint-reservation-cap.test.ts`.
- C2: `scale-sizes.ts` ya no lee el entorno. El blinding del ledger se deriva del `noteCounter` del snapshot; no hay `randomBytes` en la transición.
- C3/C4: cuerpo HTTP por defecto 64 KiB, decimales canónicos de hasta 30 dígitos, y 500 sin mensaje interno.
- Informe y disposición: `docs/audit/AUDIT-v0.5.6.md`. I1–I12 quedan registrados; no se cierran en este release salvo la decisión de entropía de I1.


## 0.5.6 — 2026-10-08

Marketplace load sizes. Protocol fee 0.1 % and Marketplace fee 3 % are unchanged.

- The 20k settlement run accepts 20,000, 50,000, 100,000 and 500,000. CI stays on 20k.
- `npm run simulate:20k|50k|100k|500k` and `npm run test:scale:50k|100k|500k|all`.
- Listing capacity grows with the run (at least 100) so a larger size does not exhaust stock. The hot-listing check stays at capacity 100.


## 0.5.5 — 2026-10-08

SpendCircuit fold freeze (UEP-26.3). Protocol fee 0.1 %, Marketplace fee 3 %, Poseidon BN254 constants and the UEP-26 leaf encoding are unchanged.

- Transaction commitment inside the spend circuit is frozen on `hFoldV2` (version domain 6, length prefix, fold version 2).
- Circuit tag is `UEP-27-SPEND-POSEIDON-D32-v5-foldv2`. v4 proofs do not verify under this tag and must be re-proved.
- Note commitments, nullifiers and the wallet `canonicalTxCommitment` stay on the previous composition.
- Freeze record: `uep-core/UEP-26.3-FOLD-V2-FREEZE.md`. Wallet-side binding: `src/core/spend-circuit-freeze.ts`.
- `CIRCUIT_CONSTRAINTS` remains the v4 measurement until `uep-zk count-constraints` is re-run. No ceremony key is cut in this release.


## 0.5.4 — 2026-10-08

Package version `0.5.4`. Hardening on top of 0.5.3. Protocol fee stays 0.1 %, Marketplace fee stays 3 %, time stays block height, Poseidon BN254 constants and the UEP-26 `hFold` used by note/tx commitments stay frozen.

- H-1: removed `outputStash`. Prepared outputs have an explicit lifecycle (prepared → sent / expired / rejected) and the ledger does not retain blinding.
- H-2: the tautological amount+1 binding check is replaced by `canonicalInputs` + `openNote` + shape + recomputed commitments/nullifiers + value conservation.
- H-3: pending uses `pendingByTxId` and a nullifier index. Snapshot export reuses a generation cache and does not re-sign the queue.
- M-1: issuer mints reserve an index and an ephemeral blinding. Two concurrent prepares no longer collide into `MINT_REQUEST_STALE`; a later reservation waits (`MINT_RESERVATION_HELD`) until the earlier one is applied or released.
- M-2: `hFoldV2` (version domain + length prefix) and `migrateFold`. Existing commitments stay on `hFold`. Snapshot format 10 records `foldVersion: 2`.
- M-3: mint and spend blinding come from an ephemeral secret mixed with a wallet-domain separator, not from the public account id.
- M-4: `networkId`, `protocol` and `version` are checked; snapshots carry a domain-separated `networkTag` and persisted policy windows.
- Indexes: owner → notes, pending nullifier, marketplace buyer → orderId. `restoreChain` verifies intermediate links without rebuilding their state. `snapshotDelta` exports a checkpoint suffix. Optional Poseidon WASM loader (`src/core/poseidon-wasm.ts`, `uep-core/uep-poseidon-wasm`) uses the same constants; JS remains the default.
- Snapshot format 10. Format 9 migrates by derivation (`9->10`); transactions, mints and notes are not rewritten.


## 0.5.3 — 2026-10-08

Package version `0.5.3`. From 0.5.3 on, versions are numeric semver only (`MAJOR.MINOR.PATCH`, release tag `vMAJOR.MINOR.PATCH`); `npm run check:version` enforces it. Earlier entries keep their historical `-public-iot-m2m` names. Fixes and wiring on top of 0.5.2. **Review status:** External reviews of later versions have taken place; their reports are not yet published in this repository and will be added (with version and remediation status) as they are incorporated. The last externally reviewed threshold with a published report in this repository is v0.4.6. ([`docs/SECURITY-COVERAGE.md`](./docs/SECURITY-COVERAGE.md)); the changes since then, with their tests and status, are listed in [`docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md`](./docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md). No native token, no common currency, no runtime dependencies; protocol fee 0.1 %, Marketplace fee 3 %; time is block height.

### Ledger and assets

- **Asset registry wired into the ledger** (ADR 0001): the ledger can be built from a signed registry manifest: only listed assets are minted and spent, decimals and network must match, a deprecated asset cannot be minted (earlier mints stay valid), the fee floor comes from the registry, and the registry binding is checked on restore. **Mints under a registry use the manifest issuer key set and its threshold (M-of-N):** `prepareIssuerMint()` returns the request bound to the next mint index, note and manifest version; at least `threshold` distinct issuer keys sign `issuerMintMessage()` (own domain, separate from faucet mints) and `mintWithIssuerSignatures()` applies it. The faucet (and the v0.4.7 single issuer key) mints only test assets (`uep-test/*`) under a registry (`FAUCET_TEST_ASSETS_ONLY`), the registry `supplyCap` is enforced (`MINT_SUPPLY_CAP`), and restore re-checks every issuer mint against the manifest version it names (not above the bound version). Mint records gain optional `registryVersion` / `issuerSignatures`; earlier records and ledgers without a registry are unchanged. Snapshot **format 8** binds the registry hash; migration 7 → 8; golden fixtures `v7-v0.5.2-7173d37` and `v8-v0.5.3`.
- **12-block catch-up cap as a state invariant (snapshot format 9):** every `advanceHeight()` call that seals blocks counts one tick, and the snapshot records `ticks = { count, maxBlocksPerTick: 12, mode }`. `restore()` checks `height <= ticks x 12`, and across a chain link or against a checkpoint the height may grow by at most 12 per added tick (`INVALID_SNAPSHOT_HEIGHT_CAP`). Snapshots of `testOnlyUnboundedHeightAdvance` ledgers are marked `test-unbounded` and restore only with the same test-only option. Migration 8 → 9 derives the smallest consistent tick count (`ceil(height / 12)`); golden fixture `v9-v0.5.3`. The cap bounds blocks per tick; it is not a rate limit against an operator who calls the producer in a loop.
- **Wallet migration of v2 receive-only accounts:** `walletAccountBalances()` shows the v3 and v2 balances of one mnemonic, and `migrateV2ToV3()` sweeps the v2 notes to the v3 id with ordinary signed spends (0.1 % fee each; notes too small for the fee floor are reported as dust). Tested against state written by v0.5.0 (`src/identity/fixtures/v2-receive-only-v0.5.0.json`, public data only).
- **Multi-input transactions (UEP-C04, ADR 0004):** up to 8 inputs (`MAX_TX_INPUTS`) of one sender and one asset in one transaction, one protocol fee, change consolidated into one note. `inputNonces` / `inputNullifiers` are optional fields: single-input transactions, their ids and their serialization are unchanged, so no snapshot migration is needed. `prepareMultiInputSpend()`, `buildSpend(Note[])`; reconciliation and conflict marking use every nullifier. The development MAC path and zk-spend refuse multi-input. Self-transfers are still refused; consolidation happens through the change note.
- **zk-spend on the transaction path (partial):** an optional `zkSpendVerifier` is accepted only when it is not a development-key verifier in a production environment; the ledger binds public inputs 4..11 (ids, asset, amount, fee, nullifier, commitment) to the transaction before verifying. The sender signature is still required (`docs/LABS.md` point 7).
- **zk-spend root binding (opt-in) and re-verification:** `zkRootBinding: "circuit-projection"` binds the root public inputs 0..3: the ledger state and nullifier trees are projected to circuit depth 32 (`CircuitTreeProjection`; slot = low 32 bits of the same key H_ACCOUNT(account, asset); state leaf = the circuit balance leaf with blinding 0; nullifier leaf = nullifier), and `zkLedgerTransition()` gives the old and new roots and depth-32 paths a witness must use. A lab test checks leaves, slots and roots against the Rust circuit code (`uep-zk note-commit`, `state-index`, `smt-root 32`). A slot collision refuses the zk-spend (`ZK_SLOT_COLLISION`); a root-bound zk-spend must be first in a batch. `zkAccountIds()` is the single account-id derivation adapter (core key-derived v3/v2 ids, or the circuit H_ACCOUNT id) and the witness contract uses it. Restore re-verifies zk-spend transactions (bound inputs and the verifier passed as `RestoreOptions.zkSpendVerifier`; `INVALID_SNAPSHOT_ZK_VERIFIER`, `INVALID_SNAPSHOT_TX_ZK_PROOF`), and the pending queue applies the same zk-spend checks as `submit()`.

### Settlement and Marketplace

- **Atomic settlement commit:** port moves are journaled; on failure they are undone and the treasury fee allocation is reverted; a failed undo halts the engine.
- **Signed credits by default** (`requireSignedCredits`); unsigned credits only through test-only options, refused in production.
- **Marketplace snapshot** (format 3) with persisted settlement receipts; migrations 1 → 2 → 3 and golden fixtures. Format 3 is signed (Ed25519 over the snapshot hash, `snapshotSigningKeys`; restore checks a trusted signature), persists the order-id counter (after a restart a new order never reuses an id that already has a receipt; an explicit one is refused with `ORDER_ID_CONFLICT`), and lists the legacy v1 receipts carried over from a migrated snapshot. Unsigned format 1 / 2 snapshots restore only with `acceptUnsignedLegacySnapshot`; migration 2 → 3 derives the counter from the receipt count (generated ids are hashes, so the counter cannot be read back from them).
- **Settlement receipts v2** bind the `networkId` in the receipt hash; v1 receipts verify through a versioned alias but are accepted only as listed legacy receipts of a migrated old snapshot and are never anchored. Anchors refuse receipts from another network.
- **Anchor authorization:** `UepLedger.anchorSettlements` anchors a batch under a Marketplace id only with a signature of that Marketplace's registered anchor key over the request (network, ids, anchor index, previous anchor, receipt hashes); `setSettlementAnchorAuthority` / `settlementAnchorAuthorities`, `Marketplace.anchorPublicKeyHex()`.
- **Evidence: Sybil cost without a token.** A listing bound to an attester set locks a provider bond (`sellerBond`) in the listing asset, at least `providerBondBps` (default 10 %) of the per-provider subcap, taken from the provider's balance at publication and returned once the listing is delisted and has no open funded evidence-bound order (`EVIDENCE_PROVIDER_BOND_REQUIRED`, `INSUFFICIENT_FUNDS_FOR_BOND`, `listingBondLocked()`, `valueAccounting().listingBonds`). One buyer may fill at most `buyerCapBps` (default 25 %) of a set cap (`EVIDENCE_BUYER_CAP_EXCEEDED`); hitting the buyer quota is the buyer's own limit and does not close the reservation without fault. Listings without evidence terms keep `sellerBond` as a declared term.
- **Listing delist:** `delistListing(listingId, auth)` (provider-signed `delist`): no new reservations, running orders continue, the same terms can be published again.
- **HTTP height producer checked for real:** `listenUepHttpApi` and `createUepHttpApi` accept only a `HeightProducer` (`HEIGHT_PRODUCER_INVALID`) that seals the height the Marketplace reads (`HEIGHT_PRODUCER_MISMATCH`; strict when the Marketplace uses `heightOf(ledger)`, otherwise by comparing heights). `GET /v1/marketplace/height` adds `producer: { running, aheadBy, allowedHeight, droppedBlocks, lastError? }`; `HeightProducer.status().lastError` records the error that stopped the timer; `producer.target`. An injected producer `clock` (or `testOnlyClock`) is refused under `NODE_ENV=production`.
- Smaller fixes: a note with a negative bigint `amount` is refused like its string form; an order's `domainProfile` is fixed at reservation like its windows.
- **Retired ledger:** after `restore(..., { replaces })` the old ledger refuses spends (`prepare*`, `submit`, `submitBatch` → `LEDGER_RETIRED`), faucet, issuer key changes, height advances, anchors and snapshot signing, so only one history can continue.
- **Ledger anchors (settlement bridge):** settlement batches are verified, hash-chained and stored in ledger state (snapshot format 8) and re-checked on restore ([`docs/SETTLEMENT-BRIDGE.md`](./docs/SETTLEMENT-BRIDGE.md)). A cumulative receipt log with RFC 9162 consistency proofs links the batches.

### External review 2026-10-08 (provided by the project director): fixes

Each finding was first reproduced against the code (`docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md`, section "External review provided by the project director, 2026-10-08").

- **Marketplace snapshot format 4: full state.** The signed snapshot now carries the Marketplace state (balances, deposits, escrow holds, listings, active and closed orders, provider bonds, category holds, treasury, paymaster, evidence exposure, idempotency and replay records) through a tagged, lossless codec (`src/marketplace/marketplace-state.ts`), so a restart loses nothing that the snapshot covers. Migration 3 → 4 sets `state: null` (receipts-only shim, the format 3 behaviour); golden fixture `mkt-v3-receipts-signed.json` written by the format 3 code. Restore re-applies the immutability of published terms, checks configuration, freshness and clock, and re-checks value conservation. Runtime capabilities (category hooks and ports, oracle gate) are not persisted and are re-attached before restore.
- **Bounded ledger submit queue with backpressure.** `LedgerSubmitQueue` (`src/service/ledger-submit-queue.ts`) runs submissions one at a time in arrival order, holds at most `maxDepth` (default 256) waiting ones and answers `LEDGER_BUSY` (`reason: "QUEUE_FULL" | "QUEUE_TIMEOUT"`, `retryAfterSeconds`) when full or after `timeoutMs` (default 30 s) in the queue; it yields to the event loop between ledger turns. HTTP API 1.4.0: `POST /v1/ledger/transactions` when a `ledgerQueue` is attached (202 / 400 / 503 + `Retry-After`), and `LEDGER_BUSY` on `POST /v1/spends` maps to 503 + `Retry-After`. The ledger's re-entry guard is unchanged.
- **O(1) history indexes in the ledger.** The replay checks of `submit()`, the pending queue and `reconcilePending()` use a txId index and a committed-nullifier index (`hasCommittedTx()`, `hasCommittedNullifier()`) instead of scanning the transaction history; the indexes are derived data (not in the snapshot), built incrementally, rebuilt when `txs` is replaced and rebuilt (and cross-checked against the nullifier set) on restore.
- **Marketplace retention policy (bounded memory, replay protection kept).** Closed orders keep their full record for `closedOrderRetentionHeights` (default 30 days of heights) after closing; `pruneRetention()` then replaces the record, its settlement record and its fund / deliver idempotency entries by a tombstone (status, close height, settlement receipt hash; `orderTombstone()`). A tombstoned id is never reused, replays of its reservation or actions are refused (`ORDER_PRUNED`), and the settlement receipt stays in the engine. Reservations may be signed with an optional `notAfterHeight` (signed only when set, so earlier signatures are unchanged): after it the reservation is refused (`RESERVATION_AUTHORIZATION_EXPIRED`) and its idempotency entry is dropped; entries of reservations without it are kept. Listing rate-limit timestamps outside the window are dropped, idempotency keys are limited to 256 characters (`IDEMPOTENCY_KEY_TOO_LONG`), and `retentionStats()` reports the sizes. The retention state is part of snapshot format 4.
- **Ledger off the service event loop.** `LedgerWorkerHost` (`src/service/ledger-worker-host.ts`, `node:worker_threads`) runs the ledger on a worker thread (built from options or restored from a signed snapshot) with asynchronous `submit` / `submitBatch`; combined with `LedgerSubmitQueue` the largest event-loop stall while submitting drops from ~860 ms to a few ms (measured in `docs/PERFORMANCE.md`, `scripts/bench-ledger-cost.ts`). The SMT depth-254 cost itself is unchanged (~100–180 ms per new leaf, ~440 ms per submit); a Wasm Poseidon is not built (no wasm32 target in this toolchain; residual with a plan in `docs/PERFORMANCE.md`).
- **Height authority.** `UepLedger` and `ProducedHeight` hand out one height authority (`claimHeightAuthority()` / `releaseHeightAuthority()`, `HeightAuthorityGuard` in `src/core/height.ts`); while it is claimed, `advanceHeight()` needs it (`HEIGHT_AUTHORITY_REQUIRED`). `HeightProducer` claims it at its first tick or `start()` and releases it at `stop()` (`exclusive`, default true; `holdsHeightAuthority`), so a running node advances height only at real-time pace and a second producer cannot start (`HEIGHT_AUTHORITY_TAKEN`). Without a claim the earlier behaviour applies. Operator control of the process remains a documented residual until distributed consensus.
- **HPKE for relay payloads.** `src/core/hpke.ts`: RFC 9180 base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305 on `node:crypto` only (no dependency), checked against the RFC 9180 Appendix A.2.1 vectors (key derivation, key schedule, encryptions at sequence numbers 0–256, exports). `sealRelayPayload()` / `openRelayPayload()` seal a relay payload end to end to the recipient's X25519 key in ordered chunks (index and count in the AAD; info binds network and recipient id); the relay fair-exchange key that is published after payment then reveals only ciphertext, and `prepareBlob()` and the fraud proofs work on the sealed blob unchanged. Sealing is client-side; recipient keys are distributed out of band.
- **ZK residuals and coverage records.** `docs/EXTERNAL-AUDIT-PACKAGE.md` section 6 states the ZK residuals precisely (development keys from a public seed, no ceremony, depth-32 slot collisions refused with `ZK_SLOT_COLLISION`, sender signature still required, no sender or amount privacy) and the new residuals (height operator after the height authority, Marketplace retention of legacy reservations, ledger submit cost, no Wasm Poseidon). The review is recorded in `docs/SECURITY-COVERAGE.md` and `docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md` with the verification result of each finding; `docs/MODULES.md` and the README module table list the ledger service adapters (module 17), Marketplace snapshot format 4, the retention policy and HPKE.

### Oracle (commit `1c9f712` and follow-ups)

- One signing key counts as one source; re-registering a source with another key is refused (explicit `rotateSourceKey`); quote payload v2 carries the `networkId` with a locally derived domain separator (V52-04); capped weighted median; signed `SettlementAuthorization` v2; legacy v0.1 quotes only through an explicit shim.
- **`OraclePolicyGate`** wired into Marketplace listings and reservations, IoT tariffs and hashlock swaps.
- **No-dependency rule:** listings (and IoT listings) opt in per listing with signed `oracleReference`; the signed `onOracleUnavailable` (`FOLLOW_SIGNED_PRICE` by default, or `BLOCK_NEW`) decides what new operations do when the oracle is unavailable, and an out-of-band quote still refuses them. Orders, listings and swaps store the check outcome with the hash of the aggregated quote used. Refunds, timeouts, disputes, settlement and transfers never consult the oracle (`oracle-liveness.test.ts`). IoT `requireOracleTariff` is a deprecated no-op shim.
- **Aggregation:** an outlier source is dropped on its own instead of rejecting the feed; only `ACTIVE` sources signed with their current key count (revocation and key rotation take effect immediately); at an exact half split of weight the price is the floor of the mean of the two middle quotes.
- **Registry and network binding:** rotated-out keys and keys of revoked sources are retired (never counted or registered again); `REVOKED` is final; re-registration cannot change weight or status; keys must be prime-order points; the Marketplace refuses an oracle gate of another network and the gate refuses aggregators that accept unbound v0.1 quotes; `AuthorizationLedger` requires a `networkId`.
- **Swaps: explicit opt-in.** The swap rate check runs only when the buyer signs an `oracleBand` in the intent; a registry pair policy or pause no longer binds a swap, and `setPairPaused` no longer creates a pair policy. The outcome (with the aggregated quote hash) is stored on the swap. `requireOracle` / `maxSkewPpm` constructor options are deprecated shims.
- Data-source policy in [`docs/ORACLE.md`](./docs/ORACLE.md): FX reference rates are display-only; future physical-trigger adapters need at least 2 origins and k-of-n signed evidence; NWS and IMF are not used; optional LEI checked offline (`isValidLei()`, ISO 17442); a leap-seconds file is deferred and would only ever be used in an exporter.

### Category modules

- **V52-01:** a relay dispute that times out after `KEY_RELEASED` resumes the order (the fraud window is extended by the frozen time) instead of refunding 80 % to the buyer; the buyer keeps the fraud-proof path. New optional `timeoutOutcome()` on disputable categories.
- **V52-02:** a wrong key (`KEY_RELEASE_FAULT`) or no key by the deadline pays `faultBondSlashBps` (default 20 %) of the provider bond to the buyer.
- **V52-03 (mitigation):** a dispute timeout pays `timeoutBondToRespondentBps` (default 20 %) of the claimant's bond to the respondent.
- **Maximum freeze duration:** a dispute freeze lapses after `MAX_FREEZE_HEIGHTS` (241,920 heights, 14 days at 5 s). After it the order's own refund / timeout path opens without a verdict (swap `expire`, relay `expire` or `finalize`, explicit `lapseFreeze()`); a relay frozen over its key deadline is refunded without a provider fault, and the fraud window gets back at most the cap. A late dispute timeout then only settles the claimant's bond (`freezeLapsed`). Dispute engines must use `evidenceHeights + resolutionHeights` below the cap (`DISPUTE_WINDOWS`).
- Per-asset dispute bond minimum (`minBondByAsset`); ported module tests (relay fraud and slashing, dispute quorum, frivolous disputes, hashlock-swap and drip negatives, deterministic fuzz) with a shared harness.
- Naming: "hashlock swap" (`src/category/swap.ts`, bilateral) vs "AMM lab pool" (`src/lab/liquidity.ts`, research simulation).
- Category commitments stay SHA-256 (reasons in [`docs/CATEGORY-MODULES.md`](./docs/CATEGORY-MODULES.md), together with the other residual limits).

### Cryptography, labs and tooling

- **Strict Ed25519 everywhere:** `verifyEd25519` refuses small-order, identity and non-canonical public keys, small-order or non-canonical R and S ≥ L before calling the backend, so Node 22 and Node 24 give the same answer. Sender authorization, oracle quotes, Marketplace actions, IoT telemetry and agent signatures all go through it. Vectors in `src/core/crypto-vectors.test.ts`.
- Published test vectors: RFC 9162 (roots, inclusion, consistency, exhaustive up to 40 leaves), RFC 8032 Ed25519, FIPS 180-4 SHA-256, RFC 5869 HKDF, RFC 8439 ChaCha20, circomlib Poseidon. New RFC 9162 consistency proofs in `src/core/rfc9162-merkle.ts`.
- Witness contract: core account-id derivation by default, circuit derivation in an explicit mode; the two skipped witness-contract tests are enabled.
- Rust lab crates `uep-23-state-transition` and `uep-24-atomic` compile on the pinned arkworks 0.3 API and run in `npm run test:rust`.
- **Lab known issues: 14 → 0.** The lab TCP mesh lost both sockets when two nodes dialled each other at once; both ends now keep the socket opened by the smaller node id, and `ProcessCluster.start()` waits for a full mesh before a test starts. `uep35.7.1-consensus` also needed the economic commitment on single-batch proposals. 12 files left `scripts/lab-known-issues.json` after repeated clean runs on Node.js 22 and 24 and now block CI; The last two were a test bug and a lab-protocol bug: `uep37.5-stress` proposed every height from `mn-0` although the leader rotates with the height (now proposes from the reported leader; `ProcessCluster.propose()` returns the outcome of its own command), and P4 proposals in `uep38-p4-view-mesh` did not carry their view, so replicas refused the new leader (proposals now carry `view`; a fresh proposal must match the adopted view, `VIEW_MISMATCH`). `scripts/lab-known-issues.json` is empty (`docs/LABS.md`).
- V52-05: the donation address check decodes bech32 / bech32m offline (BIP-173 / BIP-350 vectors) and runs in CI (`npm run check:donation`). The address is a donation address only.
- V52-06: `docs/ECONOMIC-MODEL.md` aligned with the fee buckets in `src/marketplace/economy.ts`.
- CI: `npm run test:core` on Node.js 22.x and 24.x, plus a blocking `labs` job (`build:uep-zk` + `test:lab`); the labs with known issues stay non-blocking. The README states what the badge covers.

### Documentation

- `docs/SECURITY-COVERAGE.md` and this CHANGELOG reconciled (v0.4.6 is the last externally reviewed threshold with a published report in this repository; reports of later reviews are added as they are incorporated); new `docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md`.
- New `docs/MODULES.md` and a `README.md` in each module directory; README "Modules at a glance".
- `docs/AUDIT-FIXES.md` and `docs/SETTLEMENT-AUDIT-REPORT.md` were integration notes, not audits: moved to `docs/history/` with honest titles; the old paths are redirect stubs.
- CONTRIBUTING (project rules, good first contributions, reviewing) and a good-first-issue template.
- `src/service` was not moved: its paths are public imports; a move would need re-export shims (see `docs/MODULES.md`).

### Compatibility

- Snapshot format 9 (formats 6, 7 and 8 migrate). Marketplace snapshot format 4 (formats 1, 2 and 3 migrate; a migrated format 3 snapshot restores receipts only). HTTP service API 1.4.0. Receipt hash v2 (v1 verifies through the alias). Oracle quote payload v2 (v0.1 only with `acceptLegacyV1Quotes`).
- **Behaviour change:** unsigned Marketplace credits need a test-only option; relay disputes that time out after the key resume the order; dispute timeouts move part of the claimant's bond to the respondent (`timeoutBondToRespondentBps: 0` restores 0.5.2).

### Tests (0.5.3)

- `npm run test:all` passes on Node.js 22.23 and 24.21 (Rust 1.85.1): determinism lint (140 files, 0 violations), snapshot compatibility (format 9, 3 migration steps from format 6), donation-address check, protocol 199/199, Marketplace + IoT + HTTP + height producer + submit queue + worker host 210/210, settlement 19/19, oracle 37/37, category 23/23, poisoned clock 425/425, smoke, quickstart, 20k simulation (20,000 settled, 0 errors, value conserved), Rust 127 (uep-21 7, uep-25 9, uep-26 99, uep-23 6, uep-24 6), labs 116 files / 546 tests (known-issue list empty, down from 14). Re-checked on 2026-10-08 after the external-review fixes.
- Earlier README and CHANGELOG test counts disagreed; this entry is the reference for 0.5.3.

## 0.5.2-public-iot-m2m — 2026-10-05 (not released separately; included in 0.5.3)

Package version `0.5.2-public-iot-m2m`. Version 0.5.2 integrates three module packages into the testnet reference: a **settlement engine** (single payout executor behind the Marketplace), **category modules** (swap, relay, dispute, drip) over Marketplace HOLDs, and an **oracle layer** for policy evaluation only. Attack-battery fixes from BATTERY-2026-10-05 that are cheap and critical are included. No native token; fees unchanged. Status: IMPLEMENTED (testnet reference) — not a production, ZK-ready or throughput claim.

### Settlement engine (`src/settlement`)

- Single payout executor: plans then commits (conservation `escrow = providerNet + fee + gas + buyerRefund`); `SETTLEMENT_ALREADY_EXECUTED` / `SETTLEMENT_REENTRANT`.
- Marketplace `payout()` and category `settleHold()` go through it. Receipts are canonically hashed; batches use the shared RFC 9162 Merkle tree (`src/core/rfc9162-merkle.ts`).
- Duplicate incoming `reference-ledger` and settlement `canonical.ts` removed; balances stay on the Marketplace.

### Category modules (`src/category`)

- **swap** / **relay** / **dispute** / **drip** operate on a once-issued `CategoryEscrowPort` / `SubsidyPort` from the Marketplace (no private ledgers or treasuries).
- Amounts are `bigint` (ADR 0001); time is Marketplace height (ADR 0002). Auth is Marketplace `ActorAuth`.
- One fee path: marketplace fee only on the provider part of a settlement; no protocol fee on business-layer releases.
- Relay custody/delivery split: once the committed key is published, `custodyBps` (default 2000 = 20 %) is paid unless fraud is proven; disputes apply `releaseBps` to the remaining delivery tranche.
- Drip claims only against the settlement index written by swap/relay; at most 50 % of that order's marketplace fee, once per order, from DISTRIBUTABLE_PROFIT within an admin-signed budget.
- Dispute: k-of-n arbiter quorum; bond `max(50, 1 % of escrow)`; frivolous full-loss forfeit 80 % respondent / 20 % RISK_RESERVE; timeout default refunds the buyer.

### Oracle layer (`src/oracle`)

- Real Poseidon BN254 from `src/core/poseidon.ts` (the incoming homemade permutation is removed).
- Heights for staleness / drift; synchronous Ed25519 via `src/core/ed25519.ts`; strict public-key equality.
- Used only in policy evaluation (SVC SLA, IoT tariff, dispute evidence, AMM skew). Never imported from `src/core` / `src/testnet`; never holds balances.

### Attack battery (BATTERY-2026-10-05)

| Item | Status |
| --- | --- |
| Concurrent double spend | `LEDGER_BUSY` re-entrancy guard + `SpendSerializer`; concurrent tests |
| Sybil slot saturation | `maxUnfundedReservationsPerListing` (default 3) on top of existing caps |
| Cancel vs accept race | `order.version` + optional `expectedVersion` → `ORDER_STATE_CONFLICT` |
| Paymaster drain | Sponsorship held and captured only on settle; create/cancel releases (test) |
| Relay all-or-nothing | Custody 20 % / delivery 80 % (above) |
| IoT synthetic telemetry | Deferred to Evidence (multi-attester); documented |
| HPKE for relay payloads | Deferred; payload digests remain visible to relayers |

### Tests and CI

- Scripts `test:settlement`, `test:oracle`, `test:category` included in `npm test` / `test:all` and the poisoned-clock suite.
- Determinism lint scans `src/settlement`, `src/category`, `src/oracle`.
- Value accounting gains `categoryHeld`, `treasuryTransfers`, `subsidiesPaid`.

### Residual limits

- Category commitments (hashlock, relay key commitment, chunk trees) are SHA-256, not Poseidon.
- In-process isolation only (capability object references).
- Height is only as good as the height source.
- No arbiter appeal / staking / rotation; oracle sources are configured keys (no on-network oracle consensus).


## 0.5.1-public-iot-m2m — 2026-10-03 (not released separately; included in 0.5.2 on `main`)

Version 0.5.1 combines deterministic, height-based transitions with domain delay windows and evidence value caps, a compatibility policy with chained snapshot migrations, and fixes from a non-public independent assessment of v0.5.0 (no public remediation report; v0.4.6 remains the last threshold with a published remediation document, see docs/SECURITY-COVERAGE.md). No native token; the protocol fee (0.1%) and the Marketplace fee (3%) are unchanged.

### Deterministic transitions, domain delay windows and evidence caps

See `docs/adr/0002-deterministic-transitions.md` and `docs/EVIDENCE.md`. No native token; fees unchanged.

- **No external calls or wall clock in transitions.** The core, the testnet ledger, the Marketplace (including `settle()`, `deliver()`, settlement guards and category validators) and the IoT/M2M service no longer read `Date.now()` or `new Date()`. Time comes only from the block height, never from a header timestamp. `npm run lint:determinism` fails on clock reads (including aliases of `Date` and any use of `performance`), timers, `fetch` and `globalThis.fetch` / `globalThis['fetch']`, randomness (`Math.random`, `crypto` random and key generation), `eval` / `Function`, computed `import()`, imports of network, file, process, timer and loader modules, and imports of helpers outside the scanned paths. It also checks the import closure statement by statement (bare builtins, npm packages, `file:` URLs, absolute, `#` and template specifiers are refused) and flags key agreement (`createECDH`, Diffie-Hellman), process-state reads, `Atomics.wait`, `WeakRef` and `FinalizationRegistry`. Its allowlist has five test-only entries, two line-scoped entries for the Ed25519 key generators and one for the `NODE_ENV` guard, each with a justification. The lint and the poisoned clock are guards against accidents, not a sandbox (ADR 0002 lists what they do not catch). It runs first in `npm run test:all` and as its own CI step. `npm run test:poisoned-clock` (in `test:all`) runs the testnet, Marketplace, IoT, compatibility, HTTP and height-producer suites with the clock, timers, network and randomness poisoned inside transitions, and fails on any use.
- **Deterministic height.** The single-node testnet ledger has `height` and `advanceHeight()`. The Marketplace and the paymaster require a height source (`height: () => ledger.height`); the IoT service uses the Marketplace clock. Tests may use `testOnlyLocalHeight: true`. The millisecond counter is renamed `testOnlyNowMs` (`now` is a deprecated alias) and the ms mode is scheduled for removal in 0.6.0.
- **Height producer** (`src/service/height-producer.ts`). Outside the transitions, it seals one block per 5 s measured on a monotonic clock (`performance.now()`), so system-clock steps seal nothing and are only logged (`wall-clock-jump`). One tick seals at most 12 blocks (`MAX_BLOCKS_PER_TICK`); the rest of a longer gap is dropped and logged (`catch-up-capped`). A restarted node does not count its downtime: windows freeze, so operator downtime extends deadlines and never expires a party. It never adds to a height advanced by someone else, refuses block times below 5 s, stops when its ledger is retired by a restore and can be moved with `rebind()`. The smoke test, the quickstart, the 20k simulation and the HTTP API (`listenUepHttpApi({ heightProducer })`) run with it, so rate limits roll and reservations expire in real time again. The single-node operator is the time authority (`docs/THREAT-MODEL.md`). The reference block time is in the network profile and in `listing.windows`.
- **Windows in heights.** Defaults at the 5 s reference block time: reservation TTL 120 heights (10 min), cancellation grace 24 (2 min), delivery dispute window 17,280 (24 h), dispute resolution 120,960 (7 days), read authorization TTL 60 (5 min), listing window 720 (1 h), paymaster quote TTL 120, IoT telemetry maximum age 60 (5 min) and future skew 6 (30 s), security-policy window 12 (60 s). The `*Ms` options are still accepted and are converted (rounded up).
- **Domain profiles.** A listing declares `domainProfile` `EARTH` (default), `MOON` or `MARS` at publication. The profile is signed when it is not EARTH and cannot change. It adds a fixed delay to every counterparty window: one worst-case round trip plus 25%, i.e. 0, 1 and 602 heights (MARS: 50.17 min, from a maximum one-way light time of 20.06 min computed offline from the public JPL DE442s ephemeris). IoT telemetry from Mars that arrives 338.3 s or 1,203.6 s after observation now settles with the default configuration. EARTH behaviour is unchanged. Solar conjunctions and contact gaps are not covered.
- **Evidence caps.** Listings may bind to a configured attester set (`evidencePolicy: { attesterSetId, maxValuePerContract }`). An attester set names its `sourceId` and its attesters' Ed25519 keys. Keys are normalized and must be prime-order curve points (zero, identity, small-order and off-curve keys are refused), and each key may belong to one set only until phase 2.3. Inside a set one provider may hold at most `providerCapBps` of the cap (default 25%). When funding fails because a cap is full, the reservation closes without fault and the buyer's deposit is returned. `reserve()` rejects an order above the per-contract cap. Only funded orders (HELD, DELIVERED, DISPUTED) count against the set cap, which `fundOrder()` takes before any value moves, so unfunded reservations cannot fill it. Settlement rechecks the per-contract cap. `marketplace.evidenceCaps` is a read-only view. By default no attester sets are configured, and listings without an evidence policy are unchanged. Evidence records and attester selection are left for roadmap phase 2.3.
- **Changes and their compatibility** (details in `docs/COMPATIBILITY.md`):
  - Snapshot format 7 adds `height`. Format 6 snapshots are migrated (height 0); format 5 and older are refused, with the reason.
  - `lastReconcileAt`, spend `createdAt`, treasury entry timestamps, read `issuedAt` and telemetry `observedAt` are heights. Unix-ms values are converted by deprecated shims where a deterministic conversion exists.
  - `MarketplaceReputation.score(sellerId)` works without `now` again (deterministic default, no clock).
  - `SecurityPolicy` uses `windowHeights` and probe `height`; the legacy names are still accepted, with a deprecation warning. `windowMs` is converted with `ceil(windowMs / 5000)` like every other `*Ms` option.
  - Listing terms, domain profile and windows are non-writable inside the Marketplace. `attachCategoryService()` refuses a category that already has listings or orders (`CATEGORY_SERVICE_IN_USE`).
  - Transactions carry their notes in one canonical serialized form, and the transaction chain hash uses it: a snapshot that went through a generic bigint-preserving JSON codec restores, and repeated restarts keep the payload byte-identical. The snapshot format is unchanged.
  - CI has a non-blocking `tsc --noEmit` job.
  - **Account ids v3.** Key-derived account ids and addresses are version 3: a version byte, 23 bytes of key hash and a 64-bit check, so a legacy id is taken for a key-derived one with probability 2^-64 or less (v2 relied on the top byte alone). v2 ids and addresses keep working and are classified as v2; spend v2 notes with `withAccountIdV2()`. `prepareSpend()`, `preparePayment()` and `faucet()` accept v3 ids and v2 ids proven by a committed spend, never a legacy id.
  - **Height safety.** `advanceHeight(n)` seals at most 12 blocks per call outside test mode (`HEIGHT_ADVANCE_CAP`). `restore()` / `restoreChain()` never lower the height below the replaced ledger, `minHeight` or the trusted checkpoint unless `allowHeightRegression: true` (`INVALID_SNAPSHOT_HEIGHT_REGRESSION`), and retire the replaced ledger. The paymaster must read the same height source as the Marketplace (`heightOf(ledger)`), not only the same unit. The HTTP API refuses a Marketplace on an injected height source without a height producer (`HEIGHT_PRODUCER_REQUIRED`).
  - **Test-only options.** `testOnly*` options are refused under `NODE_ENV=production`; `assertNoTestOnlyOptions()` / `parseUntrustedOptions()` refuse them in parsed input.
  - Category hooks are copied and frozen at `attachCategoryService()`, listings are not extensible, order windows are frozen, and the evidence cap state is an ECMAScript private field. Serialized notes reject non-canonical field elements.
  - **Breaking:** a Marketplace or paymaster without a height source throws `HEIGHT_SOURCE_REQUIRED` instead of keeping a counter that never moves. Pass `height: () => ledger.height` with a running `HeightProducer`, or `testOnlyLocalHeight: true` in tests.
  - **Breaking:** combining two of a height source, `testOnlyLocalHeight` and the legacy `testOnlyNowMs` / `now`, or giving both a `*Heights` and a `*Ms` option, throws `CLOCK_CONFIG_CONFLICT` (ambiguous configuration).

### Compatibility policy, snapshot migrations and deprecated shims

See `docs/COMPATIBILITY.md` and `docs/adr/0003-compatibility-and-migrations.md`. No native token; fees unchanged.

- **Snapshot migration registry** (`src/testnet/snapshot-migrations.ts`): chained, append-only steps vN → vN+1, each pure and documented field by field. Restore checks the snapshot as signed, then migrates, then runs every invariant. Step 6 → 7 derives:
  - `height = 0` and `lastReconcileAt = 0`;
  - `windowHeights = ceil(windowMs / 5000)`;
  - namespaced policy asset keys.

  Format 6 snapshots of the Poseidon release (with the old asset ids) and of v0.5.0 restore, keep their balances and accept new spends. The next snapshot links to the signed one. Formats 1–5 are refused with the reason (hash change; signatures bind the old values).
- **Golden fixtures** in `src/testnet/fixtures/snapshots/`: format 5 (v0.4.7, refusal), two format 6 fixtures and one format 7 fixture. They were generated by the historical code with ephemeral keys and hold public data only. `snapshot-fixtures.test.ts` loads every fixture on every run.
- **CI check** `npm run check:snapshot-compat`: fails when the snapshot format or payload shape changes without a migration step, a fixture and an updated `FORMAT.json` lock. It runs in `npm run test:all` and as its own CI step.
- **Asset id aliases:** the pre-release ids (`asset:test:eur`, …) map to `<namespace>/<symbol>` through `LEGACY_ASSET_ID_ALIASES`, in snapshots, the ledger API and the Marketplace. Old-encoded notes stay spendable, and `balanceOfAsset()` adds up both encodings.
- **Deprecated shims with warnings** (stable `UEP_DEP_*` codes, kept for at least one minor version):
  - `*Ms` options and the test-only `now`;
  - `prepareSpend()` with a Unix-ms `now`;
  - `SecurityPolicy({ windowMs })`;
  - `x-uep-issued-at` / `auth.issuedAt` in Unix ms, mapped to a height in the service API and HTTP adapter (not in the Marketplace);
  - IoT `now`, now ignored with a height-based Marketplace instead of throwing.
- New `GET /v1/marketplace/height` (HTTP adapter 1.3.0), `ledger.restoredFrom` and `lastReconcileHeight`, and `snapshotToJSON` / `snapshotFromJSON`.
- Not compatible, with explicit errors: IoT telemetry signed with a Unix-ms `observedAt` (`IOT_TELEMETRY_OBSERVED_AT_UNIT`), and an in-process Unix-ms `issuedAt` without a derived height (`ACTOR_AUTH_ISSUED_AT_UNIT`).

### Fixes from the independent assessment of v0.5.0 (non-public; no remediation report published)

- **`/v1/objects*`: Host and Origin allowlist (DNS rebinding).** Before any authorization, the object routes check the request's `Host` header against an allowlist (default: `127.0.0.1`, `localhost`, `::1` and the bind host when it is not a wildcard; `allowedHosts` option or `UEP_HTTP_ALLOWED_HOSTS`) and its `Origin` header, when present, against exact origins (default: the same-origin loopback origins of the listening port plus the CORS allowlist without `*`; `objectsAllowedOrigins` option). A port in `Host` must be the listening port. A missing, malformed or foreign `Host` is `403 OBJECTS_HOST_NOT_ALLOWED`, a foreign or `null` origin `403 OBJECTS_ORIGIN_NOT_ALLOWED`, with or without a bearer token. HTTP adapter version 1.3.0 (which also adds `GET /v1/marketplace/height`).
- **Lab node domain binding.** `LabNode` validates its domain (a non-negative safe integer, `DOMAIN_ID_INVALID`), requires an operator-configured `defaultVkHex` and any registry key to be pinned for that domain (`VK_NOT_PINNED_FOR_DOMAIN`), and in ZK mode requires the proof's `domain_id` public input to equal the signed envelope domain and the node domain (`ZK_PUBLIC_DOMAIN_MISMATCH`, `ZK_DOMAIN_MISMATCH`), the same rule as the pinned verifiers. A proof made for another domain is rejected even when the envelope is correctly signed.
- **Self-certifying namespaces with 130 bits.** `selfCertifiedNamespace()` now returns `k-` + 26 base32 characters of SHA-256 over the owner key set (domain `UEP-NAMESPACE-v2`), up from 13 characters (65 bits). Asset ids under such a namespace may be up to 44 bytes and use a packed field encoding above 2^248, so the encoding stays injective over all valid ids; every other id keeps its v0.5.0 field element.
- **ZK verifying keys: development keys only.** The pinned verifying keys are development keys. ZK verification in the labs is not trustworthy until a real multi-party setup ceremony is held. Loading the development pin file is refused when `NODE_ENV=production` or `UEP_ZK_KEY_MODE=production` (`VK_DEV_KEYS_REFUSED`) and warns once outside development/test runs; a pin file that is not labelled `DEV-TEST-KEYS` but lists a development key is refused (`VK_DEV_KEYS_MISLABELED`).

### Tests (v0.5.1)

- `npm run test:all` passes on Node.js 22.23 and 24.21 (Rust 1.85.1): determinism lint (78 files, 0 violations), snapshot compatibility check, protocol 140/140, Marketplace + IoT + HTTP + height producer 173/173, the same suites under the poisoned clock 275/275, smoke, quickstart, 20k simulation (`hotExpired: 100`, value conserved), Rust 115, labs 98 files / 463 tests (14 known-issue files skipped as before). `src/testnet/key-derived-accounts.test.ts` is deterministic (400 repeated runs, 0 failures).

### Compatibility (v0.5.1)

- **Behaviour change (HTTP):** object routes reached through a name other than loopback or the bind host now answer 403 until that name is listed in `allowedHosts` / `UEP_HTTP_ALLOWED_HOSTS`, even with a valid bearer token. Browser pages need their origin in `objectsAllowedOrigins` or the CORS allowlist. Clients that send no `Origin` (curl, server-to-server) are unaffected.
- **Behaviour change (labs):** `new LabNode()` throws on an invalid domain or on a `defaultVkHex` that is not pinned for the node's domain; ZK envelopes whose proof was made for another domain are rejected.
- **Asset registry, compatibility path for legacy `k-` names:** names created with v0.5.0 (`k-` + 13 characters) remain valid and readable: manifests that list them load unchanged, with the same manifest hash and the same asset field encodings (tested against a frozen v0.5.0 manifest). `legacySelfCertifiedNamespace()` reproduces the old derivation, `selfCertifiedNamespaceVersion()` tells the two apart. New manifests and version bumps cannot introduce a legacy name (`ASSET_REGISTRY_LEGACY_NAMESPACE` in the builder, an upgrade problem on load); `buildSignedAssetRegistry({ allowLegacySelfCertifiedNamespaces: true })` exists only to rebuild old fixtures. Code that assumed every asset id is at most 31 bytes should use `parseAssetId()` / `assetIdToFr()`.

## 0.5.0-public-iot-m2m — 2026-10-03 (GitHub Release `v0.5.0`, the latest published release) — research labs, Poseidon protocol hash, asset model and hardening

Version 0.5.0 bundles the research-labs integration and the Poseidon protocol hash (first sections below, unchanged) with the v0.5.0 work: namespaced assets and an asset registry manifest, circuit v4 with (account, asset) state keys, API authorization hardening, remote-safe signed spends, paymaster reserve protection, a compressed sparse Merkle tree and fixes from two non-public independent assessments (no public remediation report; see docs/SECURITY-COVERAGE.md). No native token; the protocol fee (0.1%) and the Marketplace fee (3%) are unchanged.

### Security hardening (v0.5.0)

- **API authorization hardening.** Marketplace and IoT/M2M calls of the service API and the HTTP adapter are authorized only by the actor's Ed25519 signature over the canonical action message (`src/marketplace/identity.ts`). HTTP carries it in `x-uep-actor-id`, `x-uep-signature` and `x-uep-issued-at` (required for reads). A missing or invalid authorization is `401 UNAUTHORIZED`, a valid one for the wrong actor `403 FORBIDDEN`; `x-uep-caller-id` is ignored. Fund, deliver, settle and cancel pass the signed authorization to the Marketplace; `POST /v1/marketplace/orders` passes the buyer's reservation signature and idempotency key; the treasury snapshot (`GET /v1/marketplace/treasury/<asset>`) needs a signed administrator `read`. HTTP status codes follow the error code. HTTP adapter version 1.2.0. End-to-end HTTP tests cover anonymous, wrong-actor and correctly signed calls.
- `/v1/objects*`: a bearer token (`objectsToken` option, constant-time comparison) when configured; without one, only loopback hosts are served.
- **CORS:** off by default (same-origin only). `cors.allowedOrigins` or `UEP_HTTP_CORS_ORIGINS` (comma-separated) lists exact origins; `*` only if listed explicitly; credentials are never allowed. `OPTIONS` preflight answers `204`.
- **Pinned verifying keys (development keys only).** Lab verifiers use the development verifying key pinned by SHA-256 per depth and domain (`uep-core/vectors/UEP-ZK-DEV-VK-PINS.json`; deployments set `UEP_ZK_VK_PINS_FILE`). A key carried in a message must match the pinned key (`VK_PIN_MISMATCH`); `VerifyingKeyRegistry.pin()` only accepts pinned keys. Pinning fixes which key a verifier uses; it does not make that key trustworthy. The pinned keys are development keys only, and ZK verification is not trustworthy until a real multi-party setup ceremony is held (see `SECURITY.md`).
- **Strict field parsing** in `uep-zk` and the canonical-state parser: values `>= p` are rejected, no truncation through `u128`. The circuit library computes the fee with 128-bit intermediates (large amounts) and `prove-spend-json` rejects amount overflow.
- `uep-zk` is executed in place; a private temporary copy (mode 0700, removed at exit) is made only when the build output is not executable.
- `src/service/index.ts` no longer re-exports the lab proving queue.
- **Remote-safe spends.** `prepareSpend()` / `preparePayment()` build `sender-signature` spends by default: the client signs the transaction binding with its key-derived spend key and uses the sender-bound nullifier `H_NULLIFIER(H_NULLIFIER(tag, senderId), nonce)`; the node verifies with the public key only, `submit(tx)` without any secret. The development MAC stays as a clearly labelled local, in-process option (`{ authorization: "development-mac" }`, verified only by `submit(tx, secrets)`). Restore and the offline queue check the sender-bound nullifier.
- **Paymaster reserve protection.** Sponsorships carry the buyer and a hold deadline (the reservation expiry) and are released automatically when it passes: lazily before every new sponsorship and through `sweepExpired()`. Per-actor caps (`maxOutstandingPerActor`, default 32 open sponsorships; `maxActorShareBps`, default 25% of the asset's sponsor capacity) and per-order caps (`maxOrderShareBps`, default 10%; optional `maxGasPerOrder`). Delivered orders keep their sponsorship until settlement; `release()` is idempotent. Tested with 1,000 fake orders.
- **Listing checks without full scans.** Exact duplicates use a fingerprint index; near-duplicates (Jaccard >= 0.9 per provider, category and asset) use a token prefix-filter index with the same result as the exhaustive check.

### Assets (v0.5.0)

- **Namespaced asset ids** `<namespace>/<symbol>` (lowercase, at most 15 + 15 characters): `uep-test/teur` (2 decimals), `uep-test/tbtc` (8), `uep-test/tenergy` (resource credit, kWh), `uep-test/tdata` (resource credit, GB), `uep-global/eur` (reserved), `uep-sim/senergy`, `uep-sim/scompute`. Decimals are bounded to 8. Resource credits describe their measurement; the measured quantity is evidence, separate from the settlement asset.
- **Asset registry manifest** (`src/core/asset-registry.ts`): namespaces with owner key sets (including self-certifying `k-…` names), assets admitted by the namespace owner, per-asset issuer key sets with real thresholds, issuer keys disjoint across assets and from owner and governance keys, governance-signed versions with immutable economics (symbol, kind, decimals, fee floor, supply cap, unit, measurement) and no removals. The ledger does not consume the manifest yet (see `docs/adr/0001-asset-model.md`).

### Research spend circuit v4 (v0.5.0)

- `UEP-27-SPEND-POSEIDON-D32-v4-assetkey`, 155_393 constraints at D=32 and 48_097 at D=4: every state slot is keyed by `H_ACCOUNT(account, asset)`, the circuit constrains each index to the low bits of its key and requires the sender, recipient and treasury slots to be distinct. Witness builders, the execution engine and the SMT economic state reject an index collision (`SMT_INDEX_COLLISION`).
- New CLI commands `uep-zk dev-vk <depth>` and `uep-zk state-index <account> <asset> <depth>`; `dev-vk` prints a development key (development and tests only, no ceremony).

### Performance (v0.5.0)

- **Compressed sparse Merkle tree** (`src/core/smt.ts`): only non-empty leaves and branch points are stored (2n − 1 nodes for n leaves) and empty subtrees use the precomputed default hashes; roots, paths and serialization are identical to the previous tree (root-equivalence tests against the previous implementation at depths 4, 8, 32 and 254). Memory benchmark: `npm run bench:smt` (depth 254, 10,000 accounts: 19,999 stored nodes and 2.05 MiB retained, against 2,358,302 nodes and 428.45 MiB for the previous tree, about 209 times less memory, same root; insertion time is dominated by Poseidon in TypeScript and did not improve).

### Labs (v0.5.0)

- The rotating-leader lab follows the single-proposer schedule (UEP-37.6) and the digest-only aggregate proposal path; two lab files leave the known-issue list (14 remain, mostly multi-process timing). The uep37.5 state-slot collision is resolved by the v4 (account, asset) keying and the collision rejection.

### Documentation (v0.5.0)

- `docs/adr/0001-asset-model.md`: unit of account (D-1), asset model (D-3), openability and the pending ledger integration. `docs/API.md` lists the changed signatures of v0.5.0.

### Compatibility (v0.5.0)

- **Behaviour change:** asset ids are renamed (see above). The old ids are accepted as deprecated aliases, and pre-release format 6 snapshots with the old ids restore through the 6 → 7 migration (see "Compatibility policy" above). Snapshots may contain `sender-signature` spends.
- **Behaviour change:** spends are `sender-signature` by default and their nullifiers differ from development-MAC spends. Code that relied on `submit(tx)` failing without secrets must build `{ authorization: "development-mac" }` spends.
- **Behaviour change (HTTP/service API):** marketplace and IoT calls need signed actor authorization; `x-uep-caller-id` has no effect; `marketplaceDeliverOrder()` no longer takes a provider id.
- **Behaviour change (labs):** proofs and keys of circuit v3 do not verify under v4; verifiers no longer take a verifying key from the message; `UEP_P4_VK_HEX` is no longer read.

### Research labs integration and Poseidon protocol hash

(Previously listed as "Unreleased".)


Publishes the project's research labs next to the testnet so that everything builds and tests with one command, and moves the testnet core to the same Poseidon hash as the research spend circuit. No native token; the protocol fee (0.1%) and the Marketplace fee (3%) are unchanged. See [`docs/LABS.md`](./docs/LABS.md).

#### Research labs

- Add `src/lab/` (execution engine, node protocol and transport, local consensus experiments, economic labs, address and payment-request labs, network adaptation simulation, ZK bridge), `src/agent/`, a service/API lab in `src/service/`, and the Rust crates and design notes in `uep-core/`. These were internal lab experiments during the project's early stage; they are now public as experimental code. Lab benchmark output goes to `artifacts/`, which is git-ignored.
- Labs import the hardened primitives from `src/core` instead of carrying their own copies. The differences found between the labs and the core are resolved toward the safer design (hash, small-amount fee, v1 addresses, domain binding) or documented as open (circuit tree depth, in-circuit account ids); see `docs/LABS.md`.
- `uep-zk` is built from source (`npm run build:uep-zk`); no prebuilt binary is committed. Lab code no longer falls back to a shared `/tmp/uep-zk` copy.
- Liquidity-pool lab (simulation only): the 0.3% swap fee is split into a 0.1% protocol share, accounted per asset for the treasury, and a 0.2% liquidity-provider share that stays in the pool. Both are configurable (`feePpm`, `protocolFeePpm`) and validated.

#### Protocol hash (testnet core)

- Note commitments, nullifiers, the sparse Merkle tree, the note tree and transaction commitments use **Poseidon over BN254** (x^5, t = 3, 8 full + 57 partial rounds, circomlib-compatible constants; `src/core/poseidon.ts`, backend `uep-poseidon-bn254-x5-3-v1`). It is checked against the uep-21 vectors in `uep-core/vectors` and matches the spend circuit's leaves. Non-canonical field inputs are rejected (`POSEIDON_INPUT_NOT_CANONICAL`). The previous SHA-256-to-field backend stays in `src/core/hash.ts` as an inactive reference (`Sha256FieldReferenceHash`).
- **Snapshot format version 6.** Formats 3–5 are rejected with `INVALID_SNAPSHOT_VERSION`.

#### Research spend circuit (UEP-26)

- Circuit v3 (`UEP-27-SPEND-POSEIDON-D32-v3-feefloor`, 153_956 constraints at D=32): the fee must be `max(1, floor(amount / 1000))`, the same rule as the core, and `amount = 0` is rejected. The UEP-25 reference state machine uses the same rule.
- The TypeScript verification helpers require the expected `domain_id` and reject a proof for another domain.

#### Compatibility

- **Behaviour change:** testnet state, snapshots (format 5 or earlier) and stored commitments, nullifiers, roots or transaction ids from earlier versions are not valid any more; re-create the testnet state. Mnemonics, spend keys, account ids and `uep1…` addresses are unchanged.
- **Behaviour change (labs):** proofs from the v2 circuit do not verify against v3 keys; `verifyZkSpendProofAgainstExpected()` takes an `expectedDomainId` argument.
- `npm run test:protocol` has 83 tests (4 new Poseidon vector tests) and takes about a minute, since Poseidon in TypeScript is slower than SHA-256.

#### Documentation

- README: new "Origin and motivation" section (the research question the project started from) and a status legend (implemented on testnet, experimental lab, planned, research); a "Research labs" overview; status table with the Rust and lab test counts; repository layout updated (Poseidon, composite keys, `uep-core/` structure); ZK and multi-node sections reworded now that the labs are public.
- New `uep-core/README.md`: index of the Rust crates and lab design notes, with guidance on lab status words, historical notes and internal-workspace test commands.
- Lab design notes: Spanish notes translated to English; stale paths (`src/core/…` → `src/lab/…`) and stale statements (testnet hash, fee floor in ECON-01/02 and UEP-25) corrected.
- `docs/ARCHITECTURE.md`, `ROADMAP.md`, `docs/REPRODUCIBILITY.md`, `docs/THREAT-MODEL.md`, `SECURITY.md`, `CONTRIBUTING.md`, `NOTICE` and the PR template updated for the research labs (scope, counts, troubleshooting). No code, test or configuration change.

#### CI

- `npm run test:all` now also runs `test:rust`, `build:uep-zk` and `test:lab`; it is the blocking CI job on Node.js 22.x and 24.x with Rust 1.85.1 and a cargo cache.
- The lab files with known issues (`scripts/lab-known-issues.json`, mostly multi-process timing) run in a separate non-blocking job, so the CI badge reflects the core.

## 0.4.7-public-iot-m2m — 2026-10-02

Multi-asset hardening of the testnet ledger and the Marketplace, following the external multi-asset (P4) exit-criteria review. No native token; the protocol fee (0.1%) and the Marketplace fee (3%) are unchanged. Testnet only, single node, same trust model. See [`docs/API.md`](./docs/API.md).

### Marketplace

- Harden per-asset balance keying: available balances, locked deposits and held escrow are indexed structurally by asset and then identity, and per-asset accounting reads only that asset.
- Listing index and idempotency keys use structural (injective) composite keys, also in the paymaster and the IoT/M2M service.
- Asset ids are validated (`MARKETPLACE_ASSET_ID_PATTERN`, `ASSET_ID_INVALID`). Optional `assetRegistryNetworkId` restricts listings and credits to the assets registered on a ledger network.
- Identity ids are limited to 256 characters without control characters (`IDENTITY_ID_INVALID`).
- Optional per-asset minimums: `minReservationDepositByAsset` and `MarketplaceTreasury({ minFeeByAsset })`. Defaults are unchanged (floor 1).
- Optional `requireSignedCredits`: `creditAccount()` then needs an administrator `"credit"` signature and a single-use `creditId`.

### Ledger

- Asset ids follow a canonical grammar (lowercase, 1–31 bytes) so their field encoding is injective; `validateAssetRegistry()` checks the registry (unique ids and encodings, decimals 0–18). Registered ids, encodings and commitments are unchanged.
- Per-asset issuer keys: `issuerSigningKeys`, `setIssuerSigningKey()` (install, rotate, remove). Snapshot trust accepts asset-scoped issuer keys and key revocation from a mint index (`issuerKeys`, `revokedMintKeys`).
- `restore()` rejects notes and mints of unregistered assets and mints not signed by a key trusted for that asset.
- `submit()` rejects any input or output note outside the transaction asset with `ASSET_MISMATCH`; `prepareSpend()` returns `ASSET_MISMATCH` for unregistered assets.
- Security policy limits per asset (`assetLimits`: maximum, per-window volume, minimum). Volume of different assets is never summed.
- Per-asset protocol fee floor (`AssetRecord.minProtocolFee`, default 1 for every registered asset), applied in submit, pending validation and restore. `maxPayableFromNote()` and `effectiveFeeBps()` helpers.
- Payments from several notes: `preparePayment()` + `submitBatch()` apply up to 16 single-input spends of one sender, asset and recipient atomically (all or none). Each part pays its own fee. The transaction and proof format are unchanged.
- `requireProof` is fixed at construction (`testOnlyDisableProof` for tests); assigning it throws `REQUIRE_PROOF_IMMUTABLE`.

### Compatibility

- **Behaviour change:** `ledger.requireProof = false` now throws; tests must construct the ledger with `testOnlyDisableProof: true`.
- **Behaviour change:** `prepareSpend()` with an unregistered asset returns `ASSET_MISMATCH` (was `INSUFFICIENT`); a note in another asset makes `submit()` return `ASSET_MISMATCH` (was `AMOUNT_MISMATCH` or a value error).
- **Behaviour change:** Marketplace asset and identity ids are validated; ids with control characters, empty ids or over-long ids are rejected.
- **Behaviour change:** the policy window volume is counted per asset; the spend count per window stays per account.
- **Behaviour change:** `restore()` rejects snapshots with unregistered assets; once an asset has scoped issuer keys, the global faucet keys no longer validate its mints.
- `creditAccount()` takes an optional fourth argument. No change to addresses, notes, commitments, transactions, proofs or the snapshot format (version 5).

### Known open issues

- Pending a project decision: the unit and decimals model, opening the asset registry, Marketplace–ledger bridging, Marketplace state snapshots, the fee model for small amounts and dust, dispute arbitration, ZK production, consensus and Sybil resistance.
- A true multi-input transaction and self-consolidation of notes are not available; a batch pays one fee per part.
- Unchanged: development MAC (UEP-A11, A12), ZK witness range checks (UEP-A22), self-service identities, read authorizations reusable within their TTL.

### Documentation and testing

- New `npm run test:all`: `npm test` (protocol, Marketplace, IoT/M2M and scale suites), the smoke test, the quickstart and the 20k simulation in one command. CI runs it on Node.js 22.x and 24.x.
- README Quickstart (clone, `npm ci`, `npm run test:all`), `docs/REPRODUCIBILITY.md` and CONTRIBUTING updated with the command and the expected v0.4.7 results.
- New [`ROADMAP.md`](./ROADMAP.md): phases 0–9 with goals, deliverables and exit criteria, the next Phase 2 milestones (event bus, storage and evidence, local API, IoT gateway, SDK, sandbox, simulators), and year buckets labelled as goals, not commitments.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) rewritten around layers A–N, with a status table (Implemented on testnet / Partial / Design / Future) and diagrams.
- README: current-status table (version, test counts, CI), architecture and roadmap sections linking the new documents, corrected `docs/API.md` range and v0.3.2 wording.
- CONTRIBUTING points to the roadmap for where help is needed; PUBLIC-SCOPE covers the IoT/M2M layer, roadmap and status claims; REPRODUCIBILITY lists the expected results.
- README, `ROADMAP.md` and `docs/ARCHITECTURE.md` describe the v0.4.7 per-asset hardening and the current test counts.

### Tests

- New `src/testnet/multi-asset.test.ts` (12): asset id grammar and registry checks, conservation fuzz over 4 assets with snapshot / restore / restoreChain, asset isolation, unregistered assets on restore, issuer key scope / rotation / revocation, per-asset policy limits, fee floors, multi-note payments and batch atomicity, fixed `requireProof`.
- New `src/marketplace/multi-asset.test.ts` (10): per-asset balance keying, idempotency key scope, id validation, registry mode, per-asset minimums, signed credits, a 240-order lifecycle fuzz over 4 assets checking conservation and capacity after every step, gas asset binding.
- Two existing ledger tests now use `testOnlyDisableProof` instead of assigning `requireProof`.
- Totals: protocol 79/79, marketplace + IoT 104/104, scale 3/3, IoT 23/23 on Node 22 and 24; `simulate:20k` 0 errors, value conserved.

## 0.4.6-public-iot-m2m — 2026-10-02

Fixes the two new P3 findings of the external review of v0.4.5 (UEP-D04, UEP-D05). See [`PUBLIC-SECURITY-REMEDIATION-v0.4.6.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.6.md) and [`docs/API.md`](./docs/API.md).

### Dispute timeout and category guards (UEP-D04)

- With `disputeTimeoutOutcome: "RELEASE"`, a timed-out dispute now runs the category settlement guard before paying the provider. For IoT/M2M orders, the guard requires verified telemetry of the delivered report covering the full quantity.
- If the guard fails, the order closes as `REFUND_BUYER`: gross amount and gas are returned and no fee is charged. The order gets `disputeOutcome: "TIMEOUT_REFUND_UNVERIFIED"` and the settlement record `categoryGuard: "TIMEOUT_REFUNDED"`.
- The rule is generic: it applies to any category with an attached `settlementGuard`, and IoT listings without an attached IoT service always fail it (`IOT_SETTLEMENT_GUARD_REQUIRED`).
- Every release path the marketplace controls is now guarded:
  - `settle()` on a DELIVERED order (buyer, provider after the window, arbiter);
  - the buyer's dispute withdrawal;
  - the RELEASE timeout.
- The arbiter's explicit `resolveDispute()` RELEASE or SPLIT stays final, as documented (arbiter trust). For guarded categories its record carries `categoryGuard: "PASSED"` or `"ARBITER_OVERRIDE"`.
- The IoT guard now also checks that the verified units equal the order quantity (defence in depth; `IOT_USAGE_SHORTFALL`).
- Default `disputeTimeoutOutcome` is still `REFUND_BUYER`. Its behaviour is unchanged.

### Capacity after post-delivery outcomes (UEP-D05)

- Capacity is returned to the listing exactly once, when the order closes:
  - Cancel / expire (nothing delivered): the whole quantity, as before.
  - Full release: nothing; the units are consumed.
  - Refund or split: the quantity minus the consumed units. Consumed units are the larger of the units proven executed by category evidence and the units paid for, rounded up: `ceil(providerAmount × quantity / gross)`.
- Category evidence comes from a new optional hook, `CategoryServiceHooks.consumedUnits(order)`, clamped to `[0, quantity]`.
  - The IoT service reports the units of verified telemetry bound to the delivered report.
  - So a refunded IoT order that was executed per verified telemetry does not get its executed units back. A refunded order without such evidence gets its full quantity back.
- The capacity return is computed and validated before any value moves. It fails with `CAPACITY_ALREADY_RESTORED` / `CAPACITY_ACCOUNTING_INVALID` instead of over-filling the listing. `available` never exceeds `capacity`.
- New `ServiceOrder.capacityConsumed` / `capacityRestored` and `SettlementRecord.capacityRestored` fields.
- New `capacityAccounting(listingId)`: `capacity === available + reserved + consumed`.

### Compatibility

- **Behaviour change (RELEASE timeouts):** a marketplace configured with `disputeTimeoutOutcome: "RELEASE"` now refunds, instead of paying, a timed-out dispute whose category guard fails. Unguarded categories release as before.
- **Behaviour change (capacity):** a post-delivery refund or split now returns unconsumed capacity, where v0.4.5 kept the units reserved forever.
- Additive types: `disputeOutcome` value `TIMEOUT_REFUND_UNVERIFIED`, `SettlementRecord.categoryGuard` / `capacityRestored`, `ServiceOrder.capacityConsumed` / `capacityRestored`, `CategoryServiceHooks.consumedUnits`, `CapacityAccounting`. No ledger, address or snapshot format change.

### Known open issues

- The arbiter's explicit release or split of a guarded order remains a trusted decision. It is labelled, not blocked.
- Verified telemetry proves which machine key signed a report, not that the physical service happened (machine-key trust).
- Capacity consumption is evidence-based. An IoT execution that was delivered but never verified counts as not consumed and is returned on refund. For non-IoT categories, a split is assumed to consume the units paid for, rounded up.
- Unchanged: development MAC / `requireProof` (UEP-A11, A12), ZK witness range checks (UEP-A22), self-service identities (no Sybil resistance), the `creditAccount()` stub, no key rotation, read authorizations reusable within their TTL.

### Tests

- New `timeout-guard-capacity.test.ts` (13). D04 tests:
  - a RELEASE timeout with verified telemetry pays the provider;
  - without verified telemetry it refunds in full, with no value lost and idempotent replays;
  - a verified shortfall refunds;
  - an IoT listing without an IoT service refunds;
  - a custom guard on another category gates the timeout, and unguarded categories still release;
  - the default timeout is unchanged and the withdrawal is still guarded;
  - the arbiter's explicit release is labelled.
- D05 tests:
  - a refund returns capacity once, with every replay path tried;
  - provider refund and timeout refund versus release;
  - a split returns only the unpaid units;
  - IoT units executed per verified telemetry stay consumed;
  - out-of-range evidence is clamped;
  - capacity stays within `[0, capacity]` and conserved across repeated fill-and-drain rounds.
- Totals: protocol 67/67, Marketplace/IoT 94/94, scale 3/3, IoT 23/23 on Node 22 and 24.

## 0.4.5-public-iot-m2m — 2026-10-02

Key-derived accounts and v2 addresses (option (a) for the spend-key registry left open in v0.4.4), plus the reservation-deposit minimum. See [`PUBLIC-SECURITY-REMEDIATION-v0.4.5.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.5.md) and [`docs/API.md`](./docs/API.md).

### Key-derived accounts (UEP-ADDR-002)

- The account id commits to the deterministic Ed25519 spend key: `accountId = 0x02 ‖ SHA-256("UEP-ACCOUNT-KEY-v2\n" ‖ raw key)[0..31]`. It is always a canonical field element.
- `IdentitySecrets` gains `spendPublicKey`. New helpers: `accountIdFromSpendKey`, `accountIdFromSecrets`, `isKeyDerivedAccountId`, `spendKeyMatchesAccount`, `senderAuthFailure`.
- Spends reveal the key and sign (`senderAuth`). `submit()`, pending validation and restore check, without any registry, that the key hashes to the sender and to every input-note owner (`OWNER_KEY`) and that it signed the envelope (`SENDER_AUTH`).
- Sender and recipient must be key-derived accounts.
- The v0.4.4 trust-on-snapshot spend-key registry is **removed**: `registerSpendKey`, `spendKeyOf`, `spendKeys`, `SpendKeyRegistration`, `verifySpendKeyRegistration`.

### Addresses v2

- `address = Bech32m("uep", 0x02 ‖ networkTag(4) ‖ keyHash(31))`: 68 characters, BIP-350 checksum, version byte, network tag.
- New functions: `encodeAccountAddress`, `decodeAccountAddress`, `parseAccountAddress`, `addressFromSpendKey`, `UepAddressV2`.
- Decode errors: `ADDRESS_CHECKSUM`, `ADDRESS_VERSION`, `ADDRESS_NETWORK`, `ADDRESS_HRP`, `ADDRESS_LENGTH`, `ADDRESS_FORMAT`, `ADDRESS_LEGACY_V1`. `UepAddressV1` is deprecated (encode throws, decode returns null).
- `ledger.addressOf()` and `ledger.resolveAccount()`. `faucet()` and `prepareSpend()` accept address strings (`FAUCET_ACCOUNT_INVALID`, `INVALID_ADDRESS`).

### Snapshots

- **Format version 5**; formats 3 and 4 are rejected. There is no `spendKeys` field, and a snapshot carrying one is rejected (`INVALID_SNAPSHOT_SPEND_KEY`).
- Restore checks that every note owner is a key-derived account (`INVALID_SNAPSHOT_NOTE_OWNER`). It also checks every committed spend's key/owner binding (`INVALID_SNAPSHOT_OWNER_KEY`) and signature (`INVALID_SNAPSHOT_TX_SENDER`). Pending entries are validated under the same rule.

### Marketplace and IoT/M2M

- An identity named by a ledger v2 address must register the spend key that address commits to (`IDENTITY_ADDRESS_KEY_MISMATCH`). Malformed, non-canonical, wrong-network and legacy addresses throw `IDENTITY_ADDRESS_INVALID`.
- New `ledgerNetworkId` option, default `uep-testnet-1`; `ledgerAccountOf()`; testkit `enrollAccountIdentity()`. IoT providers follow the same rule.
- **UEP-D03:** a configured `reservationDeposit` below 1 unit throws `RESERVATION_DEPOSIT_BELOW_MINIMUM`, unless the test-only flag `testOnlyAllowZeroReservationDeposit: true` permits exactly `0n`. This item was listed as "D02" in the v0.4.4 documents.
- **UEP-D02 (v0.4.3 report, unsigned `fundOrder`):** confirmed fixed since v0.4.4, because only the buyer's `fund` signature is accepted. A dedicated test was added.

### Migration

- **Old addresses are invalid.** v1 addresses (`uep:<network>:<hex>`) and `H(secret, salt)` account ids from v0.4.4 and earlier no longer work.
- The same mnemonic now derives a new account and address. Testnet state, snapshots and vaults must be re-created; legacy vaults report `LEGACY_VAULT`. No value migrates; this is a testnet.

### Compatibility breaks

- Account ids changed for every identity. `UepAddressV1` encode throws, `DecodedAddress` changed shape, and `verifySenderAuth(tx)` takes one argument.
- `registerSpendKey()` / `spendKeyOf()` are removed. Snapshot format 5 is required.
- `faucet()` / `prepareSpend()` refuse non-key-derived accounts.
- `reservationDeposit: 0n` requires the test-only flag.
- Address-shaped marketplace identity ids are validated.

### Tests

- New `key-derived-accounts.test.ts` (6): derivation and encoding; checksum, version, HRP, network, case and legacy errors with BIP-350 vectors; addresses in faucet and spends; mismatched signer key; forged registry entry; restore key/owner mismatch and non-key-derived note owner.
- New `address-identities.test.ts` (3): D02 buyer-only funding, D03 deposit minimum, address-named identities with conservation.
- New IoT test (address-named provider and buyer). Existing ledger tests were migrated (no registry; `OWNER_KEY` for foreign keys; format 5).
- Totals: protocol 67/67, Marketplace/IoT 81/81, scale 3/3, IoT 23/23 on Node 22 and 24. `smoke:testnet`, `quickstart` and `simulate:20k` pass.

## 0.4.4-public-iot-m2m — 2026-10-02

Pending-queue validation, authenticated note-commitment tree, Marketplace disputes and order access, fee floor, and signed IoT telemetry. These follow the open items of v0.4.3. See [`PUBLIC-SECURITY-REMEDIATION-v0.4.4.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.4.md) for the per-finding status and [`docs/API.md`](./docs/API.md) for the changed signatures.

### Pending queue (UEP-B06, UEP-A06, UEP-D01)

- **Sender spend keys** (`src/core/spend-key.ts`): a deterministic Ed25519 key per account, derived from the account credentials. Registration proves account control (`registerSpendKey`); `prepareSpend()` registers it automatically.
- Every spend carries `senderAuth`. `submit()` requires it from the registered key (`SENDER_AUTH`), also when `requireProof` is disabled.
- Pending entries are validated at entry:
  - envelope, fee, commitment and replay;
  - registered-sender signature;
  - canonical unspent local inputs with matching openings;
  - `checkSpendShape()` on the canonical inputs;
  - fresh outputs;
  - note membership.
- The queue is bounded (`maxPendingTransactions`, default 1024, max 100,000; `PENDING_FULL`) and de-duplicated. Offline `submit()` validates before queueing.
- `restore()` re-validates the pending queue (bound, duplicates, every entry; `INVALID_SNAPSHOT_PENDING`). Snapshots export only entries that still validate. `reconcilePending()` also flags spends sharing an input; it still never settles.

### Authenticated note-commitment tree

- `src/core/note-tree.ts`: an append-only depth-32 Merkle tree of note commitments with membership proofs, historical roots and the stateless `verifyNoteMembership()`.
- Spends carry `inputMembership`. `submit()` and pending validation verify it (`MEMBERSHIP_PROOF`); outputs that already exist are refused.
- Snapshots carry `noteRoot`, `noteCount` and the spend-key registry. Restore checks the following:
  - it rebuilds the tree and checks the root (`INVALID_SNAPSHOT_NOTE_ROOT`);
  - each replayed spend's proof is anchored before its outputs (`INVALID_SNAPSHOT_TX_MEMBERSHIP`);
  - each spend has a sender signature (`INVALID_SNAPSHOT_TX_SENDER`);
  - each spend-key registration is valid (`INVALID_SNAPSHOT_SPEND_KEY`).
- Snapshot **format version 4**.

### Marketplace disputes and order access (UEP-B07, B08, B12, A07, A09)

- Every order action is an Ed25519-signed `ActorAuth` (`signAction`, domain `UEP-MARKETPLACE-ACTION-v1`).
  - Providers must be registered and sign their listing terms.
  - The admin is verified against `adminPublicKey` (fail-closed) and the arbiter against `settlementArbiterPublicKey`.
  - Identity strings are refused.
- `getOrder()` requires the buyer, the provider, the admin, or the arbiter on a disputed order. `listOrders()` / `listOrdersPage()` return only the signer's orders, and the admin sees all. Read authorizations expire (`readAuthorizationTtlMs`, default 5 min).
- Dispute flow:
  - `openDispute()`: buyer only, within `deliveryDisputeWindowMs`, arbiter required;
  - `resolveDispute()`: arbiter only, `RELEASE` | `REFUND_BUYER` | `SPLIT`;
  - `refundBuyer()`: provider concession;
  - the buyer withdraws by settling;
  - after `disputeResolutionWindowMs` (default 7 days), `disputeTimeoutOutcome` applies (default `REFUND_BUYER`).
  - New statuses: `DISPUTED`, `REFUNDED`.
- Value conservation on every outcome:
  - the escrow is paid out exactly once;
  - a split charges the fee only on the provider share;
  - a refund returns gross + gas and releases the paymaster sponsorship.
- The provider settles only after the dispute window; the admin never settles. `marketplace-system` is reserved.
- `attachCategoryService()` gives a service layer a category-scoped read capability and settlement guard. IoT orders cannot be released without one.

### Fee floor (UEP-A16)

- `creatorFee()` (0.1%) and `calculateMarketplaceFee()` (3%) charge at least 1 unit on any positive amount (`MIN_PROTOCOL_FEE`, `MIN_MARKETPLACE_FEE`). The documented rates are unchanged above the floor.

### IoT/M2M telemetry (UEP-B13)

- The unsigned `SIMULATED` mode is removed. Machines require `publicKeyHex` and are registered with the provider's signature, and every telemetry report must be signed by the machine key.
- Monotonic sequence and nonce anti-replay are kept. The signed payload adds `unitsDelivered`.
- The provider delivers the telemetry to the order (`deliverTelemetry`). Verification accepts only that report.
- The Marketplace releases the order only with verified telemetry covering the full quantity (`IOT_VERIFICATION_REQUIRED`, `IOT_USAGE_SHORTFALL`). Shortfalls go through a dispute, with `serviceStatus().verifiedUsageAmount` available to the arbiter.
- Provider and machine deactivation require the admin signature (or the machine's provider). Reads are party-signed.
- New `src/service/iot-testkit.ts` for signed test and simulation flows. `simulate:20k` signs every action.

### Compatibility breaks

- Snapshot format 4 is required; v0.4.3 snapshots must be re-taken.
- Spends need `senderAuth` and `inputMembership` (`prepareSpend()` adds both). `queueConflict()` now returns a `SubmitResult`. New submit codes: `SENDER_AUTH`, `MEMBERSHIP_PROOF`, `PENDING_FULL`.
- Small amounts pay a 1-unit fee instead of 0.
- Marketplace calls take a signed `ActorAuth` instead of identity strings:
  - `publishListing(input, auth)` and `fundOrder(orderId, amount, auth, idem?)`;
  - `deliver(orderId, auth, bytes, idem?)` and `settle(orderId, auth)`;
  - `cancel(orderId, auth, reason?)` and `expire(orderId, auth)`;
  - `getOrder(orderId, auth)`, `listOrders(auth)` and `listOrdersPage(offset, limit, auth)`;
  - `recordSellerReview(input, auth)`.
- Admin actions need `adminPublicKey`; an arbiter id needs `settlementArbiterPublicKey`. `MARKETPLACE_VERSION` is `0.4`.
- IoT: `registerProvider`, `registerMachine`, `deactivate*`, `hold`, `settle`, `serviceStatus`, `getRequest`, `getContract` and `getTelemetry` take signed authorizations. `simulateExecution()` requires the machine private key. Machines without a key are refused. `IOT_M2M_VERSION` is `0.3`.

### Known open issues

- Development MAC and configurable `requireProof` (UEP-A11, A12): unchanged, but sender signatures are now always required.
- ZK witness range checks (UEP-A22); single-input envelope (UEP-C04, deliberate).
- The spend-key registry reaches replicas through signed snapshots; a replica cannot re-check a registration made elsewhere.
- No key rotation or revocation.
- Read authorizations are reusable within their TTL.
- The arbiter is a trusted party.
- Self-service identity registration (not Sybil resistance); `creditAccount()` testnet stub; explicit zero reservation deposit (UEP-D02).
- Capacity is not restored after post-delivery refunds.

### Tests

- New `pending-notetree.test.ts` (12): sender auth, unregistered sender, input existence/shape/spent, queue bound, offline submit, input conflicts, poisoned restore, membership proofs, restore root/proof/sender checks, `requireProof=false`, protocol fee floor.
- New `disputes-access.test.ts` (14): every dispute outcome with conservation, withdraw/concede, timeout, dispute authorization, provider claim window, read/list/modify access, provider/admin/arbiter keys, Marketplace fee floor.
- `iot-m2m.test.ts` rewritten for signed flows (22), including verified-telemetry settlement, delivered-report binding, shortfall split and over-quantity rejection.
- Existing suites migrated to the signed API.
- Totals: protocol 61/61, Marketplace/IoT 77/77, scale 3/3, IoT 22/22 on Node 22 and 24. `smoke:testnet`, `quickstart` and `simulate:20k` (20,000 settled, 0 errors, value conserved) pass.

## 0.4.3-public-iot-m2m — 2026-10-02

Snapshot authority (UEP-B05) and reservation economics (UEP-A10) redesign, following the open items of v0.4.2. See [`PUBLIC-SECURITY-REMEDIATION-v0.4.3.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.3.md) for the per-finding status and [`docs/API.md`](./docs/API.md) for the changed signatures.

### Snapshots and issuance (UEP-B05)

- The shared-secret HMAC is replaced by **Ed25519** signatures (`node:crypto`; no new dependencies). `UepLedger.restore(snapshot, trust, keys?)` takes the authority **public** keys; verifiers never need a private key.
- Optional **k-of-n** snapshot authorities (`threshold`, e.g. 2-of-3). Restore requires `k` valid signatures from distinct listed authorities; duplicates count once. Default 1-of-1. `cosignSnapshot()` adds a co-signature.
- **Hash chain:** every snapshot carries `sequence` and `prevSnapshotHash`. Restore can be pinned to `previousSnapshotHash` or a `checkpoint` (`checkpointOf()`: snapshot hash plus transaction/mint history hash chains); `UepLedger.restoreChain()` verifies an ordered series. Reordered, rolled-back or rewritten histories are rejected even when correctly signed.
- **Dedicated faucet (mint) key:** every `faucet()` mint is an Ed25519-signed `MintRecord`; the faucet key must differ from every snapshot key. Restore rejects unsigned or wrong-key mints (including mints signed by a snapshot key) and notes that are neither a signed mint nor a transaction output. Supply is derived from signed mints.
- Snapshot **format version 3**; v1/v2 snapshots are rejected with a clear `INVALID_SNAPSHOT_VERSION` message. All v0.4.2 restore invariants are kept.
- A ledger restored without private keys is verify-only (cannot sign snapshots or mint).
- Residual trust model documented (README, threat model): key holders control their own node; this is the testnet trust model.

### Reservations cost something (UEP-A10)

- Only identities with a registered Ed25519 key (`registerIdentity`) can reserve; reservations and buyer cancellations carry the buyer's signature (`signReservation`, `signCancellation`). Fail-closed: unregistered, unsigned or wrongly signed requests lock nothing.
- The deposit (default 1% of gross, minimum 1 unit, configurable) is **locked from the buyer's marketplace balance at `reserve()`**; no reservation without funds. Testnet funding rail: `creditAccount()`.
- Funding pays `grossAmount + gasFee − deposit` (`order.fundingDue`): the deposit counts toward the payment. Provider net payouts are credited at settlement.
- Unfunded expiry forfeits the deposit to the provider; buyer cancellation within `cancellationGraceMs` (default 2 min) refunds it, later forfeits it. Provider/admin cancellation and expiry of a funded undelivered order refund the buyer in full. `expire()` is only possible after the TTL.
- Per-identity concurrent reservation limit (`maxActiveReservationsPerIdentity`, default 8) and TTL (`reservationTtlMs`, default 10 min) validated. `valueAccounting(asset)` checks conservation across every path.
- A signed request authorizes one reservation (idempotent replay); an existing `orderId` can no longer be returned to another caller (`ORDER_ID_CONFLICT`).
- IoT `requestService()` requires the buyer's signature and an idempotency key; `hold()` funds the remainder. `simulate:20k` registers, funds and signs for every buyer and checks conservation.

### Compatibility breaks

- `UepLedger` option `snapshotAuthoritySecret` removed (throws `SNAPSHOT_SECRET_UNSUPPORTED`); new `snapshotSigningKeys` / `faucetSigningKey`.
- `UepLedger.restore(snapshot, secret)` → `restore(snapshot, trust, keys?)`. `signSnapshotPayload()` removed; snapshot `integrity` and `supply` fields removed; format 3 required.
- `faucet()` requires a faucet key and a positive amount.
- `acceptOrder()` / `reserve()` require a registered buyer, `idempotencyKey`, `signature` and funds for the deposit.
- `fundOrder()` amount is now `grossAmount + gasFee − reservationDeposit` (was `+ reservationDeposit`); `heldAmount` is `grossAmount + gasFee`.
- Buyer `cancel()` requires a signature and may forfeit the deposit; `expire()` before TTL throws `RESERVATION_NOT_EXPIRED`.
- `checkoutQuote().buyerTotal` no longer adds the deposit on top (new `dueAtFunding`).
- IoT `requestService()` requires `idempotencyKey` and `authorization`.

### Tests

- New `snapshot-authority.test.ts` (11): verify-only restore, wrong key, 2-of-3 with one signature, duplicate signer, chain break / reorder / rollback, rewritten history vs. checkpoint, unsigned mint, foreign-key mint, forged history signed by the snapshot key with a fake mint, key separation and legacy secret refused, authority node resuming its chain.
- New `reservation-deposit.test.ts` (12): unregistered identity, wrong key / altered terms, reserve without funds, funded path, expiry forfeit, funded expiry refund, cancel within grace refunds, cancel after grace forfeits, signed buyer cancel / provider and admin refunds, concurrency limit and defaults, replay locks once, conservation across every path including paymaster gas.
- Existing ledger, Marketplace, IoT and scale tests migrated to the new APIs.

### Known open issues

- Key holders control their own node (testnet trust model); no key rotation/revocation; checkpoints are distributed out of band; a checkpoint more than one snapshot back is checked by history prefix, not by intermediate links (use `restoreChain`).
- Identity registration is self-service (no Sybil resistance beyond the deposit); `creditAccount` is a testnet funding stub, not a payment rail; provider/admin actor ids are still caller-supplied strings; `fundOrder` is not separately signed.
- Unchanged from v0.4.2: local-note-set membership, single-input spends, unauthenticated/unbounded pending queue, development MAC and mutable `requireProof`, no dispute flow, listing IDOR, fee rounding, ZK witness range checks.

### Verification

- `npm test`: protocol suite 49/49, Marketplace/IoT suite 57/57 (Node 22 and Node 24).
- `npm run test:scale`: 3/3; `npm run test:iot`: 16/16; smoke test and quickstart pass.
- `npm run simulate:20k`: 20,000/20,000 signed, funded main-flow settlements, 0 errors, value conserved.

## 0.4.2-public-iot-m2m — 2026-10-02

Ledger, snapshot and Marketplace hardening following the external adversarial audit of v0.4.1 (`50017ea`). See [`PUBLIC-SECURITY-REMEDIATION-v0.4.2.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.2.md) for the per-finding status.

### Ledger

- Outputs are bound to the transaction: output 0 pays exactly `amount` to the recipient; the optional output 1 returns exactly `input − amount − fee` to the sender. Enforced identically by `submit()`, pending validation and `restore()` (`checkSpendShape`).
- `tx.nonce` must be the consumed note's (well-formed) nonce, anchoring the nullifier to the spent note.
- Sender, recipient and treasury must be distinct accounts (`INVALID_PARTICIPANTS`); such transfers previously left balances inconsistent with notes.
- New submit error codes: `OUTPUT_BINDING`, `NOTE_NONCE`, `INVALID_PARTICIPANTS`. Removed a redundant conservation check and an unreachable note-insertion branch.

### Snapshots

- Integrity tag verified first, in constant time (`timingSafeEqual`).
- `restore()` re-derives the full state and rejects, with specific `INVALID_SNAPSHOT_*` errors, any snapshot that `faucet()`/`submit()` could not have produced: state/nullifier roots, nullifier seen-set, note openings, nonces and duplicates, in-order transaction replay under `submit()`'s rules, spent flags, per-account balances vs. unspent notes (plus treasury fee income) and per-asset minted supply.
- Snapshot format version 2 (`formatVersion`, `supply`); v0.4.1 snapshots must be re-taken. The security policy is now required in a snapshot.
- `signSnapshotPayload()` exported for authority-side tooling and tests.

### Marketplace and IoT/M2M

- Reservations are no longer free by default: reservation deposit of 1% of gross (minimum 1 unit), configurable with `reservationDeposit` (fixed, `0n` disables) or `reservationDepositBps`. `DigitalServicesMarketplace.reservationDeposit` is replaced by `fixedReservationDeposit`, `reservationDepositBps` and `reservationDepositFor()`.
- IoT HOLD and the 20k simulation fund the deposit.

### Tests

- New `ledger-invariants.test.ts`: output binding cases, poisoned spend rejected with the honest snapshot still restorable, nonce binding, absent input commitment, transfer participants, randomized honest spends with restore, and authority-signed snapshots breaking each restore invariant.
- Tampered-snapshot tests now check that unsigned changes fail integrity and re-signed changes fail the specific invariant.
- Marketplace tests fund the default deposit; new test that a reservation cannot be funded without it.

### Known open issues

- The snapshot authority secret is symmetric: its holder can author a fully consistent history, including self-declared faucet supply.
- The reservation deposit is collected at funding, not at reservation; unfunded reservations still lock capacity until TTL, deposits are released on expiry, and identities are caller-supplied strings.
- Input membership is checked against the local note set; there is no authenticated note-commitment tree yet.
- One input note per transaction; fragmented balances cannot be combined in one spend.
- Pending validation has no sender authentication or local membership check, and the pending queue is unbounded.
- Sender authentication is still a development MAC that requires the spender's secret on the node, and `requireProof` can still be disabled.
- Marketplace: no dispute/refund flow; order listings and `acceptOrder` with an existing `orderId` are not actor-scoped.
- Testnet and Marketplace fees still round down to zero for small amounts; the ZK witness contract is unchanged (not wired, no u64 range checks).

### Verification

- `npm test`: protocol suite 38/38, Marketplace/IoT suite 44/44 (Node 22 and Node 24).
- `npm run test:scale`: 3/3; `npm run test:iot`: 15/15; smoke test and quickstart pass.
- `npm run simulate:20k`: 20,000/20,000 main-flow settlements, 0 errors.

## 0.4.1-public-iot-m2m — 2026-10-02

Ledger and IoT/M2M hardening following the external adversarial audit of v0.4.0 (`676fee6`). See [`PUBLIC-SECURITY-REMEDIATION-v0.4.1.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.1.md) for the per-finding status.

### Ledger

- Input notes must be existing unspent members of the receiving ledger; transaction-carried notes are evidence and must match the canonical note. They cannot mint balances.
- The public testnet transaction format is explicitly single-input while the envelope exposes one nullifier; multi-input aggregation is deferred until a nullifier vector is introduced.
- `prepareSpend` selects one note covering `amount + fee` and otherwise returns a structured `INSUFFICIENT` error.
- Snapshots are integrity-authenticated with an HMAC keyed by an external `snapshotAuthoritySecret`, which is never embedded in the snapshot; `UepLedger.restore(snapshot, authority)` requires it.
- `restore()` validates state/nullifier roots, note commitments, transaction commitments, transaction value conservation and snapshot integrity.

### IoT/M2M

- `settle(requestId, actorId)` requires the buyer or the configured settlement arbiter.
- IoT HOLD funds gross amount, gas fee and reservation deposit.
- Provider/machine deactivation requires an explicit administrator authorization callback.

### Fixed during integration

- `restore()` and pending validation used a value-conservation rule inconsistent with `submit()`: honest snapshots containing any transaction could not be restored and honest pending transactions were rejected. Both now apply the same rule as `submit()`.
- Pending reconciliation had reverted to marking validated transactions settled without applying them (and in practice discarded every pending transaction). The 0.4.0 semantics are restored: invalid envelopes are rejected; valid ones stay queued (`LOCAL_VALID`, flagged on conflict) until applied through authenticated `submit()`.
- Restored from 0.4.0: sorted insertion in the reservation-expiry queue, non-zero exit of the 20k simulation on errors, the deterministic BIP-39 checksum test, the CI workflow and badge, the project contact address, the README "Supporting the project" section and the full changelog history.
- `ledger-hardening.test.ts` runs once (protocol suite); restore tampering tests assert the precise error again.
- New regression tests: honest snapshot restore after several submits, valid pending transaction surviving reconciliation and restore, exact-amount spend without fee coverage, reuse of a spent input note, fabricated input note, foreign-authority snapshot, IoT settlement/deactivation authorization and deposit-aware HOLD.

### Known open issues

- Output notes are checked for value conservation but are not bound to the declared recipient and amount.
- The snapshot authority secret is symmetric; restore does not yet check that unspent notes sum to balances, that the nullifier `seen` set matches the tree, or total supply.
- Input membership is checked against the local note set; there is no authenticated note-commitment tree yet.
- A balance split across several notes cannot be spent in a single transaction until multi-input spends are supported.
- Pending validation has no sender authentication and the pending queue is unbounded.
- Sender authentication is still a development MAC that requires the spender's secret on the node, and `requireProof` can still be disabled.
- Marketplace: no dispute/refund flow; identities are caller-supplied strings; reservation deposit defaults to 0; order listings and `acceptOrder` with an existing `orderId` are not actor-scoped.
- Testnet and Marketplace fees still round down to zero for small amounts; the ZK witness contract is unchanged (not wired, no u64 range checks).

### Verification

- `npm test`: protocol suite 30/30, Marketplace/IoT suite 43/43 (Node 22 and Node 24).
- `npm run test:scale`: 3/3; smoke test and quickstart pass.
- `npm run simulate:20k`: 20,000/20,000 main-flow settlements, 0 errors.

## 0.4.0-public-iot-m2m — 2026-10-02

Public repository updated with the agreed Marketplace + IoT/M2M implementation and security hardening, addressing part of the external audit of v0.3.2 (`fde6e26`).

### Ledger

- Full 254-bit BN254 account/nullifier SMT keys.
- Fee-aware change calculation.
- Transaction-carried input/output notes with commitment verification.
- Snapshot root and note/nullifier integrity validation.
- Security-policy state retained by snapshots.
- Pending transactions are validated during reconciliation: invalid envelopes are rejected; valid ones stay queued (never marked settled without applying the transfer) until applied through authenticated `submit()`.
- Zero-value transfers rejected.

### Marketplace

- IoT/M2M service category.
- Actor identity required for order access and settlement actions.
- Delivered orders cannot be cancelled or expired.
- Reserved legacy admin identity blocked.
- Reservation deposit/identity limits and ordered expiration queue.
- Paymaster quote revalidation.
- Treasury withdrawal authorization verification.

### IoT/M2M

- Provider and machine registration.
- Optional Ed25519 machine identity.
- Deterministic canonical CBOR telemetry.
- Sequence, nonce, replay and freshness protection.
- Marketplace-backed HOLD → delivery → verification → settlement lifecycle.

### Fixed during integration

- Pending reconciliation silently dropped every pending transaction (result check never matched) and its value-conservation check double-counted the amount.
- The 20k Marketplace simulation did not pass a settlement actor (all 20,000 settlements failed) and exited successfully on errors; it now settles all orders and exits non-zero on any error.
- The reservation-expiry queue was fully re-sorted on every order (20k orders took ~3.2 s); it now uses sorted insertion (~60 ms).
- `ledger-hardening.test.ts` ran twice (in both protocol and marketplace suites); it now runs once, in the protocol suite.

### Known open issues

- Sender authentication is still a development MAC that requires the spender's secret on the node, and `requireProof` can still be disabled.
- Multi-input spends still insert a single nullifier.
- Pending/offline transactions cannot yet be applied by reconciliation (they need authenticated `submit()`).
- Snapshot restore does not check that unspent notes sum to balances or that the nullifier `seen` set matches the tree.
- Input notes carried by a transaction are not checked for membership in the receiving ledger (no note-commitment tree).
- Marketplace identities are caller-supplied strings; reservations are free by default (deposit 0) and sybil identities are not limited; `acceptOrder` with an existing `orderId` returns that order to any caller.
- Gas-quote expiry is not checked against the Paymaster's own quote.
- Testnet and Marketplace fees still round down to zero for small amounts.
- The ZK witness contract is unchanged (not wired, no u64 range checks).
- IoT/M2M was not covered by the external audit of v0.3.2.

This remains a local/testnet reference implementation; production distributed infrastructure and production ZK are not claimed.

## 0.3.2-public-security-fix — 2026-10-02

Security release following external review UEP-RR-2026-10-02-001.

- Replaced the reversible/commutative public UEP-25 algebraic hash placeholder with an ordered SHA-256-to-field reference backend.
- Enabled sender proof/authentication by default (`requireProof=true`). The development MAC remains explicitly non-ZK.
- Enforced security policy at transaction submission, not only wallet preparation.
- Bound transaction commitments and TxIDs to `domainId`; added explicit input/output cardinality markers.
- Enforced input-note value >= amount + fee and unique/exact input commitments.
- Fixed `snapshot()` by importing `serializeTx` and added restore coverage.
- Prevented reconciliation from overturning already-applied local transactions. Pending conflicts cannot invalidate a committed nullifier.
- Restricted Marketplace cancellation to buyer/provider/admin and expiration to marketplace-system/admin.
- Added adversarial regression tests for forged identities, proof bypass, policy bypass, value inflation, domain replay, snapshot/restore, hash ordering and unauthorized Marketplace actions.
- IoT/M2M is intentionally **not included** in this public release; it remains in the laboratory/master branch pending its separate audit.

## 0.3.1-public-preview — October 2026

- Added `npm run example` as the canonical public quickstart command.
- Switched the public repository license to Apache-2.0.
- Added explicit test-seed/BIP-39 disclosure and project contact addresses.
- Added a committed npm lockfile for reproducible installation.

## 0.3.0-public-preview — October 2026

### Added

- Public reproducible UEP TESTNET reference layer.
- Local in-process UEP ledger.
- Public testnet identity, transaction, note, nullifier and SMT primitives.
- Deterministic testnet smoke test.
- First-transaction reproducibility example.
- Explicit public scope boundary.
- Public architecture and threat-model documentation.
- Marketplace + testnet in one public repository.

### Retained from public Marketplace preview

- Marketplace listings and orders.
- HOLD / reservation lifecycle.
- Delivery integrity checks.
- Marketplace Treasury.
- 3% settled Marketplace fee.
- Paymaster accounting.
- Reputation and security tests.
- Synthetic 20k load simulation.

### Explicitly not promoted to production status

- ZK production proving/verification.
- Global consensus.
- Live public network endpoints.
- Interplanetary settlement.
- Production custody or payment rails.
