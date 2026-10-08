# Remediation and coverage record, v0.4.7 – v0.5.3

> **What this document is.** A self-assessment by the project: the security-relevant
> changes made after v0.4.6, the tests that cover each one and its status. It is
> **not** an external assessment, a certification or a remediation report matching an
> independent review. External reviews of later versions have taken place; their
> reports are not yet published in this repository and will be added (with version
> and remediation status) as they are incorporated. The last externally reviewed
> threshold with a published report in this repository is **v0.4.6**
> ([`PUBLIC-SECURITY-REMEDIATION-v0.4.6.md`](../PUBLIC-SECURITY-REMEDIATION-v0.4.6.md)).
> Review status per version: [`SECURITY-COVERAGE.md`](./SECURITY-COVERAGE.md).
> Nothing here means the code is ready for production use.

Status labels:

- **Implemented (testnet), tested**: the property is enforced by the local reference code and at least one negative test fails without the change.
- **Partial**: a mitigation exists, a documented part of the property is not met.
- **Open / documented limit**: not addressed; the limit is written down where the feature is described.

Findings from reviews whose reports are not yet published in this repository are summarised by property only; details stay unpublished until the report is incorporated.

## How to check this document

```bash
npm ci
npm run test:core      # everything referenced below except the labs
npm run test:all       # + uep-zk build and the research labs
```

Each row names the test file. Suite commands: `test:protocol` (`src/testnet`, `src/core`, `src/identity`), `test:marketplace` (`src/marketplace`, IoT/M2M, HTTP), `test:settlement`, `test:category`, `test:oracle`; all of them run again under `test:poisoned-clock`.

## v0.4.7 — per-asset hardening

| Change | Tests | Status |
|---|---|---|
| Per-asset balance keying, structural composite keys (listing index, idempotency, paymaster, IoT) | `src/marketplace/multi-asset.test.ts` | Implemented (testnet), tested |
| Asset and identity id validation (`ASSET_ID_INVALID`, `IDENTITY_ID_INVALID`) | `src/marketplace/multi-asset.test.ts`, `src/testnet/multi-asset.test.ts` | Implemented (testnet), tested |
| Per-asset issuer keys, rotation, revocation; restore refuses unregistered assets and foreign-key mints | `src/testnet/multi-asset.test.ts` | Implemented (testnet), tested |
| `ASSET_MISMATCH` for notes outside the transaction asset; per-asset policy limits and fee floor | `src/testnet/multi-asset.test.ts` | Implemented (testnet), tested |
| `requireProof` fixed at construction | `src/testnet/multi-asset.test.ts`, `ledger-hardening.test.ts` | Implemented (testnet), tested |
| Several-note payments (`submitBatch`, one fee per part) | `src/testnet/multi-asset.test.ts` | Superseded in v0.5.3 by real multi-input transactions (below) |

## v0.5.0 — API authorization, signed spends, assets, circuit v4

| Change | Tests | Status |
|---|---|---|
| Marketplace / IoT calls authorized only by the actor's Ed25519 signature (HTTP 401/403), CORS off by default, object-route token | `src/service/uep-http-authz.test.ts` | Implemented (testnet), tested |
| Remote-safe `sender-signature` spends with sender-bound nullifiers (dev MAC only as a labelled local option) | `src/testnet/security-regression.test.ts`, `ledger-hardening.test.ts` | Implemented (testnet), tested |
| Paymaster reserve protection (hold deadline, per-actor / per-order caps) | `src/marketplace/paymaster-reserve.test.ts` | Implemented (testnet), tested |
| Listing duplicate checks without full scans | `src/marketplace/listing-index.test.ts` | Implemented (testnet), tested |
| Namespaced asset ids, asset registry manifest (owner/issuer/governance key separation) | `src/core/asset-registry.test.ts` | Implemented (testnet), tested; wired into the ledger in v0.5.3 |
| Compressed SMT (same roots) | `src/core/smt-compressed.test.ts` | Implemented (testnet), tested |
| Circuit v4 (account, asset) slot keys, `SMT_INDEX_COLLISION`; pinned verifying keys | Rust `uep-26-spend-circuit`, `src/lab/zk-vk-pin.test.ts` | Experimental (lab); **development keys only, no ceremony** |

## v0.5.1 — deterministic transitions and compatibility

| Change | Tests | Status |
|---|---|---|
| Height-based transitions, monotonic height producer, domain delay windows (Moon, Mars) | `src/core/height.test.ts`, `deterministic-transitions.test.ts`, `src/service/height-producer.test.ts`, `src/marketplace/domain-windows.test.ts`; lint `npm run lint:determinism`; `test:poisoned-clock` | Implemented (testnet), tested |
| Evidence value caps | `src/marketplace/evidence-caps.test.ts` | Implemented (testnet), tested |
| Snapshot migration chain, golden fixtures, compatibility shims | `src/testnet/snapshot-migration-chain.test.ts`, `snapshot-fixtures.test.ts`, `src/service/compat-shims.test.ts`; `npm run check:snapshot-compat` | Implemented (testnet), tested |
| Object routes: Host / Origin allowlist | `src/service/uep-http-authz.test.ts` | Implemented (testnet), tested |
| Lab node domain binding; development ZK keys refused under production settings | `src/lab/node-domain-binding.test.ts`, `src/lab/zk-dev-keys-guard.test.ts` | Experimental (lab), tested |
| 130-bit self-certifying namespaces (legacy names readable) | `src/core/asset-registry.test.ts` | Implemented (testnet), tested |

## v0.5.2 — settlement engine, category modules, oracle (not released separately; included in 0.5.3)

| Change | Tests | Status |
|---|---|---|
| Single settlement executor behind Marketplace payouts; conservation check; re-entrancy refusal | `src/settlement/settlement.test.ts` | Implemented (testnet), tested |
| Marketplace retention policy: closed orders pruned to tombstones after a height-based window, expiring reservation idempotency (`notAfterHeight`), bounded rate-limit maps, replay protection kept | `src/marketplace/retention.test.ts` | Implemented (testnet), tested |
| HPKE (RFC 9180 base mode, X25519 / HKDF-SHA256 / ChaCha20-Poly1305, node:crypto) for end-to-end relay payload encryption; RFC 9180 A.2.1 vectors | `src/core/hpke.test.ts` | Implemented (testnet), tested |
| Height authority: a running producer is the only one that advances height (direct calls refused, one producer per ledger, no HTTP route); operator control of the process documented as residual | `src/service/height-producer.test.ts` ("height authority") | Implemented (testnet), tested; residual documented |
| Ledger on a worker thread (`LedgerWorkerHost`): service event loop not blocked by Poseidon / SMT work; measured in `docs/PERFORMANCE.md` | `src/service/ledger-worker-host.test.ts` | Implemented (testnet), tested; Wasm Poseidon not built (residual) |
| Ledger O(1) txId / committed-nullifier indexes, rebuilt on restore | `src/testnet/history-index.test.ts` | Implemented (testnet), tested |
| Concurrent double-spend guard (`LEDGER_BUSY`, `SpendSerializer`); v0.5.3: bounded FIFO `LedgerSubmitQueue` with queue-wait timeout and backpressure (HTTP 503 + `Retry-After`) | `src/testnet/concurrent-spend.test.ts`, `src/service/ledger-submit-queue.test.ts` | Implemented (testnet), tested |
| Unfunded-reservation cap, `order.version` conflicts, paymaster capture on settle | `src/marketplace/attack-battery-v052.test.ts` | Implemented (testnet), tested |
| Category modules (hashlock swap, relay, dispute, drip) over Marketplace escrow ports | `src/category/category.test.ts` | Implemented (testnet), tested; hardened in v0.5.3 |
| Oracle policy layer (Poseidon, heights, Ed25519) | `src/oracle/oracle.test.ts` | Implemented (testnet), tested; hardened in v0.5.3 |

## v0.5.3 — released 2026-10-08

### Settlement and Marketplace

| Change | Tests | Status |
|---|---|---|
| Atomic settlement commit: journaled port moves, rollback on failure, engine halts if an undo fails | `src/settlement/settlement-atomicity.test.ts` | Implemented (testnet), tested |
| Signed credits by default (`requireSignedCredits`; unsigned only through test-only options, refused in production) | `src/marketplace/multi-asset.test.ts` | Implemented (testnet), tested |
| Marketplace snapshot (signed) with persisted settlement receipts; format 4 adds the full Marketplace state (balances, holds, orders, bonds, idempotency records); migrations 1 → 2 → 3 → 4, golden fixtures | `src/marketplace/marketplace-snapshot.test.ts`, `src/marketplace/marketplace-snapshot-state.test.ts` | Implemented (testnet), tested |
| Receipts v2 bind the `networkId` in their hash; v1 receipts verified through a versioned alias; anchors refuse foreign-network receipts | `src/settlement/receipt-network.test.ts` | Implemented (testnet), tested |
| Ledger anchors for settlement batches (verified, hash-chained, in snapshot format 8, re-checked on restore) | `src/settlement/settlement-anchor.test.ts` | Implemented (testnet), tested. The anchor proves which receipts were committed; it does not move ledger value (see `SETTLEMENT-BRIDGE.md`) |
| Cumulative receipt log with RFC 9162 consistency proofs across batches | `src/settlement/cross-batch-consistency.test.ts` | Implemented (testnet), tested |
| Anchor authorization: a batch is anchored under a Marketplace id only with that Marketplace's registered anchor key | `src/settlement/settlement-anchor.test.ts` | Implemented (testnet), tested |
| Evidence-bound listings: provider bond in the listing asset and per-buyer quota (Sybil cost without a token) | `src/marketplace/evidence-caps.test.ts` | Implemented (testnet), tested. A provider with enough capital can still split identities; the bond prices it |
| HTTP API serves a Marketplace only with a `HeightProducer` that seals its height; producer status in `/v1/marketplace/height`; injected producer clock refused in live deployments | `src/service/height-producer.test.ts` | Implemented (testnet), tested |
| Negative bigint note amounts refused; order `domainProfile` fixed at reservation | `src/testnet/snapshot-canonical.test.ts`, `src/marketplace/evidence-caps.test.ts` | Implemented (testnet), tested |

### Ledger and assets

| Change | Tests | Status |
|---|---|---|
| Asset registry manifest wired into the ledger; snapshot format 8 binds the registry; migration 7 → 8; golden fixtures v7 and v8 | `src/testnet/ledger-asset-registry.test.ts`, `snapshot-fixtures.test.ts`, `snapshot-migration-chain.test.ts` | Implemented (testnet), tested |
| Mints under a registry: non-test assets need `threshold` signatures of the manifest issuer key set (M-of-N); faucet only for `uep-test/*`; registry `supplyCap` enforced; restore re-checks issuer mints against the manifest version | `src/testnet/ledger-issuer-mint.test.ts` | Implemented (testnet), tested. Without a registry the 0.5.2 behaviour is kept |
| 12-block catch-up cap as a state invariant (snapshot format 9 `ticks`, checked on restore and across chain links); migration 8 → 9 | `src/testnet/ledger-height-cap.test.ts`, `snapshot-migration-chain.test.ts`, `snapshot-fixtures.test.ts` | Implemented (testnet), tested. A cap, not a rate limit |
| Retired ledger after `restore(..., { replaces })` | `src/testnet/ledger-retired.test.ts` | Implemented (testnet), tested |
| Wallet migration of v2 receive-only accounts (`walletAccountBalances`, `migrateV2ToV3`), v0.5.0 fixture | `src/identity/wallet-migration.test.ts` | Implemented (testnet), tested |
| Multi-input transactions (UEP-C04): up to 8 inputs of one sender and asset, one fee, change consolidation; single-input transactions and ids unchanged; reconciliation over all nullifiers (ADR 0004) | `src/testnet/multi-input.test.ts` | Implemented (testnet), tested. The dev-MAC path and zk-spend refuse multi-input |
| zk-spend on the transaction path: verifier allowed only with non-development keys in live deployments; public inputs 4..11 bound to the transaction; opt-in root binding (inputs 0..3) through the depth-32 projection of the ledger trees, matching the Rust circuit code; one account-id adapter; re-verification on restore and on the pending path | `src/testnet/zk-tx-path.test.ts`, `src/testnet/zk-root-binding.test.ts`, `src/lab/zk-root-projection.test.ts`, `src/lab/zk-witness-contract.test.ts` | **Partial**: slot collisions at depth 32 (a deeper circuit is needed before root binding can be the default), the circuit nullifier and account-id derivations differ from the ledger's, the sender signature is still required, the verifier hook is synchronous, development keys only; see `LABS.md` point 7 |

### Category modules

| Change | Tests | Status |
|---|---|---|
| V52-01: a relay dispute that times out after the key was published resumes the order (no 80 % refund to the buyer) | `src/category/category-hardening.test.ts` | Implemented (testnet), tested |
| V52-02: a wrong key or no key costs the provider part of its bond, paid to the buyer | `src/category/category-hardening.test.ts` | Implemented (testnet), tested |
| V52-03: a dispute timeout pays part of the claimant's bond to the respondent | `src/category/category-hardening.test.ts` | Partial (mitigation; arbiter liveness is still an assumption) |
| Per-asset dispute bond minimum; quorum and frivolous-dispute negatives; deterministic fuzz | `src/category/category-hardening.test.ts` | Implemented (testnet), tested |
| Maximum freeze duration (`MAX_FREEZE_HEIGHTS`): after it the refund / timeout path opens without a verdict | `src/category/freeze-cap.test.ts` | Implemented (testnet), tested |
| Category commitments in Poseidon | — | Open / documented limit: SHA-256 kept (HTLC compatibility, raw chunk hashing, no circuit consumer); `CATEGORY-MODULES.md` |

### Oracle

| Change | Tests | Status |
|---|---|---|
| One key counts as one source; no silent key re-registration (explicit rotation); quote payload v2 with the `networkId` (V52-04); capped weighted median; signed settlement authorizations v2 | `src/oracle/oracle-hardening.test.ts` | Implemented (testnet), tested |
| `OraclePolicyGate`: Marketplace listing prices, IoT tariffs and hashlock-swap rates checked against a reference band; fails closed | `src/oracle/oracle-wiring.test.ts` | Implemented (testnet), tested. Sources are configured keys; no on-network oracle consensus |
| Offline LEI checksum (ISO 17442) for the optional provider field | `src/oracle/lei.test.ts` | Implemented (testnet), tested |

### Cryptography and tooling

| Change | Tests | Status |
|---|---|---|
| Published test vectors: RFC 9162 Merkle roots / inclusion / consistency, RFC 8032 Ed25519, FIPS 180-4 SHA-256, RFC 5869 HKDF, RFC 8439 ChaCha20, circomlib Poseidon | `src/core/crypto-vectors.test.ts` | Implemented (testnet), tested |
| Offline bech32 / bech32m check of the donation address in the docs (V52-05) | `npm run check:donation` (BIP-173 / BIP-350 vectors) | Implemented, tested |
| V52-06: `ECONOMIC-MODEL.md` aligned with the fee buckets in the code | Review of `src/marketplace/economy.ts` | Documentation |
| Rust lab crates uep-23 / uep-24 compile and are tested | `npm run test:rust` | Experimental (lab) |

## External review provided by the project director, 2026-10-08

Scope of the review: the pre-release commit `2cc37f3` of v0.5.3 (and `main` at `7173d37`). The
review summary was provided to the project; the report itself is not published in this
repository. Every finding was first checked against the code and reproduced with a test
or a measurement before any change; the status below is the project's verification, not
the reviewer's wording. The "Verification" column says how each finding was reproduced
on the unchanged code; each fix has a regression test listed here.

| # | Finding (neutral) | Verification | Fix in v0.5.3 | Regression test | Remaining |
|---|---|---|---|---|---|
| 1 | Marketplace balances, orders, escrow holds and provider bonds were kept in memory only; the snapshot carried settlement receipts | **Confirmed.** Restoring a snapshot of a Marketplace with a funded order gave the buyer a balance of 0 (was 999 900), no order and no listing | Snapshot format 4 with the full state (tagged lossless codec), migration 3 → 4 (`state: null`, receipts-only shim), golden format 3 fixture; restore checks configuration, freshness, clock and value conservation | `marketplace-snapshot-state.test.ts`, `marketplace-restore-ids.test.ts` | Category hooks / ports and oracle gates are code, re-attached before restore |
| 2 | `LEDGER_BUSY` without a queue or backpressure; high rejection rate under concurrency | **Partly confirmed.** `submit()` is synchronous; eight concurrent asynchronous submits of distinct spends were all accepted, so `LEDGER_BUSY` occurs only on synchronous re-entry and the stated rejection rate was not reproduced (`POST /v1/spends` goes to the lab spend inbox, not to the ledger). Confirmed: no bounded queue, no timeout, no backpressure | `LedgerSubmitQueue`: bounded FIFO, queue-wait timeout, `LEDGER_BUSY` with `retryAfterSeconds` when full or timed out; HTTP 1.4.0 `POST /v1/ledger/transactions` with 503 + `Retry-After`; `LEDGER_BUSY` on `/v1/spends` maps to 503 | `ledger-submit-queue.test.ts`, `concurrent-spend.test.ts` | Multi-process deployments still need a transactional store |
| 3 | Groth16 development keys, no ceremony, depth-32 slot collisions, sender signature still required | **Confirmed as documented residuals** (already listed in the review package) | Documentation made more precise (`EXTERNAL-AUDIT-PACKAGE.md` section 6: development keys, no ceremony, depth-32 slot collisions refused with `ZK_SLOT_COLLISION`, sender signature still required); no code change | `zk-tx-path.test.ts`, `zk-root-binding.test.ts`, `zk-dev-keys-guard.test.ts` (existing) | ZK verification must not accept value; full ZK privacy is not provided |
| 4 | A single height operator can accelerate height; the 12-block cap is not a rate limit | **Confirmed as residual.** The producer enforces 5 s spacing and 12 blocks per tick, but repeated direct `advanceHeight(12)` calls were not limited; no HTTP route advances height (checked) | Height authority: a running producer holds it, direct advances are refused (`HEIGHT_AUTHORITY_REQUIRED`), one producer per ledger (`HEIGHT_AUTHORITY_TAKEN`), looping `tick()` seals nothing beyond real time | `height-producer.test.ts` ("height authority") | An operator who controls the process can still run without a producer, until distributed consensus |
| 5 | Relay content readable by intermediaries (no HPKE) | **Confirmed.** The fair-exchange key is published after payment, so anyone who sees it can read the content; chunk digests and sizes are visible | HPKE (RFC 9180 base mode, X25519 / HKDF-SHA256 / ChaCha20-Poly1305, `node:crypto`) with the RFC A.2.1 vectors; relay payloads sealed end to end to the recipient (ordered chunks, AAD index / count, info binds network and recipient) | `hpke.test.ts` | Digests, sizes and timing stay visible; sealing is client-side; recipient X25519 keys distributed out of band |
| 6 | Poseidon / SMT depth 254 in TypeScript blocks the event loop | **Confirmed in substance.** ~440 ms per ledger submit, event-loop stalls up to ~2.3 s for eight submits; the 17 s figure is the uncompressed reference tree in one test, not the ledger path | `LedgerWorkerHost` runs the ledger on a worker thread: stall ~6–29 ms instead of ~860–970 ms (`PERFORMANCE.md`, `scripts/bench-ledger-cost.ts`) | `ledger-worker-host.test.ts` | Per-submit cost unchanged; Wasm Poseidon not built (no wasm32 target in this toolchain; plan in `PERFORMANCE.md`) |
| 7 | Replay checks scan the whole transaction history | **Confirmed** (code: `txs.some` in `submit` and the pending queue, a set over all history per `reconcilePending`; ~2.8 ms per scan at 200 000 transactions) | txId and committed-nullifier indexes, built incrementally and rebuilt on restore | `history-index.test.ts` | — |
| 8 | Unbounded Marketplace maps (orders, idempotency, rate-limit records) | **Confirmed** (never pruned) | Height-based retention instead of LRU eviction (evicting idempotency records would allow replays): closed orders become tombstones after the window, reservation idempotency records of authorizations signed with `notAfterHeight` expire, rate-limit timestamps are swept, key length capped | `retention.test.ts` | Reservations signed without `notAfterHeight` keep one small record and one tombstone each |

## Documented limits (not addressed)

- External reviews of later versions have taken place; their reports are not yet published in this repository and will be added (with version and remediation status) as they are incorporated. The last externally reviewed threshold with a published report in this repository is v0.4.6.
- ZK: development keys only (no ceremony); see the zk-spend row above.
- Consensus and networking exist only as labs on one machine; `scripts/lab-known-issues.json` is empty in v0.5.3, but the multi-process labs remain local experiments.
- External review starting point: [`EXTERNAL-AUDIT-PACKAGE.md`](./EXTERNAL-AUDIT-PACKAGE.md).
- Arbiters, oracle sources and the snapshot authority are configured keys: Sybil resistance, arbiter appeal and rotation, and oracle consensus are not implemented.
- IoT telemetry is signed by the device key; physical attestation is out of scope.
- Relay: chunk digests and sizes are visible to relayers; v0.5.3 adds end-to-end HPKE sealing of the payload (RFC 9180; client-side, recipient X25519 keys distributed out of band).
- Height is only as trustworthy as the height source.
