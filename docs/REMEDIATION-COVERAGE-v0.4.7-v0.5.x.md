# Remediation and coverage record, v0.4.7 – v0.5.3

> **What this document is.** A self-assessment by the project: the security-relevant
> changes made after v0.4.6, the tests that cover each one and its status. It is
> **not** an external assessment, a certification or a remediation report matching an
> independent review. The last externally assessed version with a published
> remediation document is **v0.4.6** ([`PUBLIC-SECURITY-REMEDIATION-v0.4.6.md`](../PUBLIC-SECURITY-REMEDIATION-v0.4.6.md)).
> Review status per version: [`SECURITY-COVERAGE.md`](./SECURITY-COVERAGE.md).
> Nothing here means the code is ready for production use.

Status labels:

- **Implemented (testnet), tested**: the property is enforced by the local reference code and at least one negative test fails without the change.
- **Partial**: a mitigation exists, a documented part of the property is not met.
- **Open / documented limit**: not addressed; the limit is written down where the feature is described.

Findings from non-public reviews are summarised by property only. Details that are not public stay non-public.

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

## v0.5.2 — settlement engine, category modules, oracle (on `main`, not released)

| Change | Tests | Status |
|---|---|---|
| Single settlement executor behind Marketplace payouts; conservation check; re-entrancy refusal | `src/settlement/settlement.test.ts` | Implemented (testnet), tested |
| Concurrent double-spend guard (`LEDGER_BUSY`, `SpendSerializer`) | `src/testnet/concurrent-spend.test.ts` | Implemented (testnet), tested |
| Unfunded-reservation cap, `order.version` conflicts, paymaster capture on settle | `src/marketplace/attack-battery-v052.test.ts` | Implemented (testnet), tested |
| Category modules (hashlock swap, relay, dispute, drip) over Marketplace escrow ports | `src/category/category.test.ts` | Implemented (testnet), tested; hardened in v0.5.3 |
| Oracle policy layer (Poseidon, heights, Ed25519) | `src/oracle/oracle.test.ts` | Implemented (testnet), tested; hardened in v0.5.3 |

## v0.5.3 — branch `v0.5.3-fixes` (not released)

### Settlement and Marketplace

| Change | Tests | Status |
|---|---|---|
| Atomic settlement commit: journaled port moves, rollback on failure, engine halts if an undo fails | `src/settlement/settlement-atomicity.test.ts` | Implemented (testnet), tested |
| Signed credits by default (`requireSignedCredits`; unsigned only through test-only options, refused in production) | `src/marketplace/multi-asset.test.ts` | Implemented (testnet), tested |
| Marketplace snapshot (format 2) with persisted settlement receipts; migration 1 → 2, golden fixture | `src/marketplace/marketplace-snapshot.test.ts` | Implemented (testnet), tested |
| Receipts v2 bind the `networkId` in their hash; v1 receipts verified through a versioned alias; anchors refuse foreign-network receipts | `src/settlement/receipt-network.test.ts` | Implemented (testnet), tested |
| Ledger anchors for settlement batches (verified, hash-chained, in snapshot format 8, re-checked on restore) | `src/settlement/settlement-anchor.test.ts` | Implemented (testnet), tested. The anchor proves which receipts were committed; it does not move ledger value (see `SETTLEMENT-BRIDGE.md`) |
| Cumulative receipt log with RFC 9162 consistency proofs across batches | `src/settlement/cross-batch-consistency.test.ts` | Implemented (testnet), tested |

### Ledger and assets

| Change | Tests | Status |
|---|---|---|
| Asset registry manifest wired into the ledger; snapshot format 8 binds the registry; migration 7 → 8; golden fixtures v7 and v8 | `src/testnet/ledger-asset-registry.test.ts`, `snapshot-fixtures.test.ts`, `snapshot-migration-chain.test.ts` | Implemented (testnet), tested |
| Multi-input transactions (UEP-C04): up to 8 inputs of one sender and asset, one fee, change consolidation; single-input transactions and ids unchanged; reconciliation over all nullifiers (ADR 0004) | `src/testnet/multi-input.test.ts` | Implemented (testnet), tested. The dev-MAC path and zk-spend refuse multi-input |
| zk-spend on the transaction path: verifier allowed only with non-development keys in production; public inputs 4..11 bound to the transaction | `src/testnet/zk-tx-path.test.ts`, `src/lab/zk-witness-contract.test.ts` | **Partial**: roots (inputs 0..3) are not bound (tree depth 254 vs 32), the circuit proves a different account-id derivation, the sender signature is still required, restore does not re-verify proofs; see `LABS.md` point 7 |

### Category modules

| Change | Tests | Status |
|---|---|---|
| V52-01: a relay dispute that times out after the key was published resumes the order (no 80 % refund to the buyer) | `src/category/category-hardening.test.ts` | Implemented (testnet), tested |
| V52-02: a wrong key or no key costs the provider part of its bond, paid to the buyer | `src/category/category-hardening.test.ts` | Implemented (testnet), tested |
| V52-03: a dispute timeout pays part of the claimant's bond to the respondent | `src/category/category-hardening.test.ts` | Partial (mitigation; arbiter liveness is still an assumption) |
| Per-asset dispute bond minimum; quorum and frivolous-dispute negatives; deterministic fuzz | `src/category/category-hardening.test.ts` | Implemented (testnet), tested |
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

## Documented limits (not addressed)

- No independent assessment of v0.4.7 – v0.5.3 has been published; the fixes above were not re-assessed by a third party.
- ZK: development keys only (no ceremony); see the zk-spend row above.
- Consensus and networking exist only as labs; several multi-process labs are timing-dependent (`scripts/lab-known-issues.json`).
- Arbiters, oracle sources and the snapshot authority are configured keys: Sybil resistance, arbiter appeal and rotation, and oracle consensus are not implemented.
- IoT telemetry is signed by the device key; physical attestation is out of scope.
- Relay payload digests are visible to relayers (no HPKE).
- Height is only as trustworthy as the height source.
