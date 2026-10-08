# External review package — v0.5.3 (branch `v0.5.3-fixes`)

> **What this document is.** The starting point for an independent review of the
> branch `v0.5.3-fixes`. It states the scope, the trust and threat model, the
> modules and entry points, how to reproduce every test, the known risks and the
> residuals the project accepts, and the status of earlier self-assessment and
> research findings. It is written by the project. It is not a review result, a
> certification or a statement that any property holds beyond what the named tests
> show. External reviews of later versions have taken place; their reports are not
> yet published in this repository and will be added (with version and remediation
> status) as they are incorporated. The last externally reviewed threshold with a
> published report in this repository is **v0.4.6** ([`SECURITY-COVERAGE.md`](./SECURITY-COVERAGE.md)).

Contact for the review and for private reports: **uep.dev@proton.me** (or GitHub
private vulnerability reporting, see [`SECURITY.md`](../SECURITY.md)).

## 1. Scope and exact commit

| Item | Value |
|---|---|
| Repository | `UEPceo/UEP-Universal-Economic-Protocol` |
| Branch | `v0.5.3-fixes` (not merged to `main`, no release, no tag) |
| Package version | `0.5.3` (`package.json`, `package-lock.json`; `npm run check:version`) |
| Code commit under review | `afe6918` — the last commit that changes code; later commits on the branch change only documentation. Reviewers should pin the full SHA they received with the review request and run `git diff afe6918..<their SHA> -- src uep-core scripts` to confirm that nothing outside `docs/`, `README.md`, `CHANGELOG.md` changed. |
| Base | `main` at v0.5.2 (`7173d37`, the commit of the last non-public review) |
| Toolchain | Node.js 22.23.x and 24.21.x, Rust 1.85.1 (as in `.github/workflows/ci.yml`), no npm runtime dependencies |

**In scope (testnet reference path):**

- `src/core` — field, Poseidon BN254 hash, notes, nullifiers, sparse Merkle trees,
  transactions, fees, heights, Ed25519 (strict), spend keys and key-derived account
  ids, asset ids and the asset registry, RFC 9162 Merkle proofs, the zk-spend adapter
  (`zk-tx-adapter.ts`) and the witness contract;
- `src/testnet` — the ledger (`ledger.ts`): spends (single and multi-input), mints
  (faucet, per-asset issuer keys, registry issuer key sets), snapshots (format 9),
  restore and migrations, settlement anchors, height advance;
- `src/identity` — mnemonic, key derivation, vault, wallet migration v2 → v3;
- `src/marketplace` — listings, reservations, escrow, evidence-bound listings
  (attester sets, caps, provider bond), paymaster, Marketplace snapshots (format 3);
- `src/settlement` — the single settlement executor, receipts, batches, anchors;
- `src/category` — hashlock swap, relay, dispute, drip over Marketplace escrow;
- `src/oracle` — source registry, quotes, aggregation, `OraclePolicyGate`;
- `src/network/profiles.ts` — network templates, treasury id;
- `src/service` — the HTTP/service API (`uep-http-api.ts`, `uep-service-api.ts`),
  the height producer and the IoT/M2M service (`iot-m2m.ts`).

**Research scope (reports welcome, no claims made):** `src/lab`, `src/agent`,
`uep-core/` (UEP-26 spend circuit, `uep-zk`, Rust prototypes). Lab code is
experimental; a lab finding is treated as research input unless it also affects
the testnet reference path.

## 2. Project rules that bound the design

- No native token and no common currency: every value is an asset with an issuer;
  fees are paid in the asset moved.
- Fees: 0.1 % protocol fee on ledger spends (`src/core/fee.ts`, with a per-asset
  floor), 3 % Marketplace fee (`src/marketplace/economy.ts`).
- No runtime dependencies; cryptography is implemented in the repository or taken
  from `node:crypto` (SHA-256, Ed25519 backend after strict point checks).
- Time is block height (ADR 0002). Wall-clock time appears only in the height
  producer, behind a monotonic clock, and in labs (`npm run lint:determinism`).
- Compatibility shims and snapshot migrations are kept: snapshots of formats 6–8
  migrate to 9 (`docs/COMPATIBILITY.md`).

## 3. Threat model (summary)

The full model is [`THREAT-MODEL.md`](./THREAT-MODEL.md). Short form:

**Assets:** balances and notes per (account, asset); escrowed value (holds, bonds,
deposits); issuance (supply per asset); snapshot integrity; settlement receipts and
anchors; signed actor authority on the API.

**Adversaries considered:** transaction forgers and replayers (double spend,
nullifier reuse, cross-network replay); Marketplace attackers (unauthorized actions,
reservation griefing, Sybil providers on evidence sets); accounting attackers
(value creation, fee bypass, rounding); snapshot forgers (tampered or replayed
snapshots, height jumps, issuance outside the issuer keys); oracle source abuse
(one key counted twice, stale or revoked keys); API callers without or with a
foreign signature; queue injectors (pending queue); telemetry forgers (IoT).

**Trusted parties (testnet):** the holders of the snapshot authority keys (what
their node signs); the faucet key (test assets only once a registry is used); the
asset issuers (`threshold` of the manifest issuer keys per asset); the settlement
arbiter (within escrowed value); oracle source keys (configured); attester sets
(configured); the single-node operator as height authority (bounded by the
12-block-per-tick cap, see section 6).

**Out of scope:** Byzantine consensus between operators, global finality, key
custody, compromised hosts or RNGs, physical delivery, legal and regulatory
questions, soundness of the research circuit and safety of the lab consensus.

## 4. Modules and entry points

| Module | Main entry points | Key invariants | Tests (suite) |
|---|---|---|---|
| Ledger | `UepLedger` (`constructor`, `prepareSpend`, `prepareMultiInputSpend`, `submit`, `submitBatch`, `enqueuePending`, `reconcilePending`, `faucet`, `prepareIssuerMint` / `mintWithIssuerSignatures`, `advanceHeight`, `anchorSettlements`, `snapshot`, `UepLedger.restore`, `restoreChain`) | conservation per asset; one spend per nullifier; inputs are canonical unspent ledger notes owned by the signing key; mints only by the key set allowed for the asset; snapshot height ≤ ticks × 12 | `src/testnet/*.test.ts` (`test:protocol`) |
| zk-spend adapter | `zkTxBinding`, `zkBindingMismatches`, `CircuitTreeProjection`, `zkLedgerTransition`, `zkRootMismatches`, `zkAccountIds`, `assertVerifierAllowed` | bound public inputs equal the transaction; roots equal the projected ledger roots (opt-in); development keys refused in live deployments | `zk-tx-path`, `zk-root-binding`, `src/lab/zk-root-projection` |
| Core crypto | `hash.ts`, `poseidon.ts`, `smt.ts`, `ed25519.ts`, `spend-key.ts`, `rfc9162-merkle.ts` | published vectors (RFC 8032, RFC 9162, FIPS 180-4, RFC 5869, RFC 8439, circomlib Poseidon) | `src/core/*.test.ts` |
| Asset registry | `asset-registry.ts` (`verifySignedAssetRegistry`, `validateAssetRegistryUpgrade`, `issuerAt`, `meetsThreshold`) | owner, issuer and governance keys separated; version chain signed | `src/core/asset-registry.test.ts`, `ledger-asset-registry`, `ledger-issuer-mint` |
| Marketplace | `Marketplace` (`publishListing`, `delistListing`, `reserve`, `fundOrder`, `deliver`, `acceptOrder`, `settle`, `openDispute` / `resolveDispute`, `exportSnapshot` / `restoreSnapshot`), `evidence.ts` | value accounting (accounts + escrow + bonds + fees) conserved; evidence caps per set, provider and buyer | `src/marketplace/*.test.ts` (`test:marketplace`) |
| Settlement | `SettlementEngine` (`engine.ts`), `batch.ts`, `anchor.ts` | single executor; atomic commit with rollback; receipts bind the network | `src/settlement/*.test.ts` |
| Category modules | `swap.ts`, `relay.ts`, `dispute.ts`, `drip.ts`, `disputable.ts` | value only through Marketplace holds; freeze lapses after `MAX_FREEZE_HEIGHTS` | `src/category/*.test.ts` |
| Oracle | `registry.ts`, `verifier.ts`, `policy-gate.ts` | one key = one source; revoked and rotated keys never count; fails closed | `src/oracle/*.test.ts` |
| Service | `listenUepHttpApi`, `createUepHttpApi`, `HeightProducer`, IoT/M2M (`iot-m2m.ts`) | signed actor headers; the HTTP API runs only with a real height producer that seals the Marketplace's height | `src/service/*.test.ts` |
| Identity | `identityFromMnemonic`, vault, `walletAccountBalances`, `migrateV2ToV3` | key-derived ids (v3; v2 readable) | `src/identity/*.test.ts` |

Module notes: [`MODULES.md`](./MODULES.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`API.md`](./API.md), [`EVIDENCE.md`](./EVIDENCE.md),
[`SETTLEMENT.md`](./SETTLEMENT.md), [`SETTLEMENT-BRIDGE.md`](./SETTLEMENT-BRIDGE.md),
[`CATEGORY-MODULES.md`](./CATEGORY-MODULES.md), [`ORACLE.md`](./ORACLE.md),
[`COMPATIBILITY.md`](./COMPATIBILITY.md), ADRs in [`adr/`](./adr/).

## 5. How to reproduce

No network access is needed after `npm ci` and the first Rust build. No private keys
are needed: tests and lab clusters generate throwaway keys in memory. The only
mnemonic in the repository is the public BIP-39 test vector.

```bash
git clone https://github.com/UEPceo/UEP-Universal-Economic-Protocol.git
cd UEP-Universal-Economic-Protocol
git checkout <pinned SHA>
# Node.js 22.23.x or 24.21.x; Rust 1.85.1: rustup toolchain install 1.85.1 && rustup default 1.85.1
npm ci
npm run test:core        # lint, snapshot compat, donation, version, npm test,
                         # poisoned clock, smoke, quickstart, 20k simulation, Rust
npm run test:all         # test:core + build:uep-zk + test:lab (all lab files)
```

Individual suites: `npm run test:protocol`, `test:marketplace`, `test:settlement`,
`test:category`, `test:oracle`, `test:poisoned-clock`, `test:rust`, `test:lab`.
One file: `node --experimental-strip-types --no-warnings --test <file>`.
Expected results and timings: [`REPRODUCIBILITY.md`](./REPRODUCIBILITY.md); the
reference counts for this branch are in the CHANGELOG 0.5.3 entry ("Tests").

`scripts/lab-known-issues.json` is empty on this branch: every lab file runs in the
blocking `test:lab`. Two individual lab tests stay skipped (they pin the SHA-256 of
a prebuilt `uep-zk` binary, which depends on the toolchain).

## 6. Known risks and accepted residuals

Each item is documented where the feature is described; the list is what a reviewer
should not report as new unless the stated bound does not hold.

**Trust and time**

- The snapshot authority, faucet (test assets), asset issuers, arbiter, oracle
  sources and attester sets are configured keys. Signatures make tampering by others
  detectable; they do not make a key holder honest.
- The single-node operator controls the height. The 12-blocks-per-tick cap is a
  state invariant (snapshot `ticks`, checked on restore) and limits mistakes and
  fast-forwards to 12 blocks per call; it is **not** a rate limit on calls. Since
  the height authority (v0.5.3) a running producer is the only caller that
  advances height (5 s spacing, direct calls refused, one producer per ledger, no
  HTTP route); an operator who controls the process can still run without a
  producer. Multi-operator heights need a block-validation rule (future consensus
  work).
- Test-only options are refused when `NODE_ENV` marks a live deployment and are
  never read from untrusted input; their presence in code is intended.

**Marketplace and evidence**

- Evidence certifies publication by an attester set, not truth (`EVIDENCE.md`).
- Sybil cost without a token: a provider bond in the listing asset (default 10 % of
  the per-provider subcap) and a per-buyer quota (default 25 % of the set cap). A
  provider with enough capital can still open several identities; the bond prices
  this, it does not prevent it.
- A buyer deposit can be returned through the no-fault close when a funding attempt
  fails for a reason outside the buyer's control; the per-buyer quota and the bond
  bound the cost of repeating this. Accepted residual for 0.5.3.
- IoT telemetry proves which device key signed, not the physical service.
- Marketplace snapshot format 4 persists the full state; category hooks / ports and
  oracle gates are code and are re-attached before restore. Retention: closed orders
  become tombstones after `closedOrderRetentionHeights`; reservations signed without
  `notAfterHeight` keep one small idempotency record and one tombstone each.
- Performance: a ledger submit costs ~440 ms of Poseidon / SMT work (depth 254) in
  TypeScript; services run the ledger on a worker thread (`LedgerWorkerHost`) and
  submit through the bounded `LedgerSubmitQueue`. No Wasm Poseidon
  ([`PERFORMANCE.md`](./PERFORMANCE.md)).

**Category modules**

- Arbiter liveness is assumed; the maximum freeze (`MAX_FREEZE_HEIGHTS`, 14 days at
  5 s) guarantees a refund or timeout path afterwards.
- Category commitments stay SHA-256 (HTLC compatibility, no circuit consumer).
- Relay: chunk digests and sizes are visible to relayers; since v0.5.3 the payload can be sealed end to end with HPKE (RFC 9180, `src/core/hpke.ts`); sealing is client-side and recipient X25519 keys are distributed out of band.

**Ledger, compatibility and identity**

- Historical compatibility paths stay readable on purpose: legacy asset-id aliases,
  v2 account ids (receive and migrate; wallet helper `migrateV2ToV3`), receipt hash
  v1 through a versioned alias, oracle quote v0.1 behind `acceptLegacyV1Quotes`,
  snapshot formats 6–8 through the migration chain.
- Legacy millisecond inputs are accepted with a deprecation warning and are removed
  in 0.6.0 (`looksLikeLegacyMs`).
- Self-transfers are refused; consolidation goes through the change note (by design).
- Without an asset registry the ledger behaves as in 0.5.2 (faucet and per-asset
  issuer keys); with a registry, non-test assets need the manifest issuer key set
  and its threshold, and the faucet mints only `uep-test/*`.

**Zero knowledge (experimental)**

- Groth16 keys are development keys derived from a public seed; no ceremony has
  been held. ZK verification must not be used to accept value; a verifier with
  development keys is refused when `NODE_ENV` marks a live deployment.
- The circuit works on depth-32 trees; the ledger trees (depth 254) are projected
  to depth 32 under the opt-in root binding. Two keys whose low 32 bits collide map
  to one slot: such a zk-spend is refused (`ZK_SLOT_COLLISION`), so a collision is a
  liveness limit for the affected account, not a soundness break; with many
  accounts collisions become likely (birthday bound around 2^16 accounts).
- A zk-spend still carries the Ed25519 sender signature and the public transaction
  fields; the ZK path does not provide sender or amount privacy.
- The ledger accepts a zk-spend only with an explicitly configured verifier and
  still requires the sender signature. Precise list of what is and is not bound
  (roots under the opt-in projection, slot collisions at depth 32, nullifier
  derivation, account-id derivation, synchronous verifier hook, multi-input):
  [`LABS.md`](./LABS.md) point 7.

**Consensus and networking**

- Consensus and networking exist only as labs on one machine (in-process and local
  OS processes over TCP). A P4 proposal sent before a replica adopts the new view
  is dropped (no re-proposal).

## 7. Earlier self-assessment and research findings

The self-assessment record is
[`REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md`](./REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md)
(per change: tests and status). Review status per version:
[`SECURITY-COVERAGE.md`](./SECURITY-COVERAGE.md). Findings from reports not yet published in this repository
are summarised by property only.

| Source | Topic (neutral) | Status on this branch |
|---|---|---|
| Non-public review of v0.5.2 (`7173d37`), items V52-01 … V52-06 | relay dispute timeout after key release; fault bond; dispute timeout bond; oracle quote network binding; donation address check; fee buckets in docs | Implemented and tested (V52-03 is a mitigation); see REMEDIATION-COVERAGE |
| V50-10 | — | Disclosed privately; not described here |
| Project research rounds after v0.5.2 (merge blockers) | anchor authorization; signed Marketplace snapshots; retired ledgers after restore; HTTP height producer binding | Implemented and tested |
| Same, decisions taken by the project | Sybil cost by provider bond and buyer quota (no token); 12-block cap as a state invariant; maximum freeze duration; wallet migration of v2 accounts | Implemented and tested (snapshot format 9) |
| Same, smaller items | negative note amounts; fixed order domain profile; test-only clock refused in live deployments; producer error reporting | Implemented and tested |
| Same, accepted residuals | no-fault close of a buyer deposit; historical compatibility paths; by-design limits (self-transfer, cap is not a rate limit); legacy millisecond inputs | Documented in section 6 |
| Audit-preparation scope | registry mints by manifest issuer key set and threshold; ZK root binding through a circuit-depth projection, one account-id adapter, re-verification on restore; last two lab files fixed | Implemented and tested; ZK remains partial (section 6) |
| External review provided by the project director, 2026-10-08 (branch at `2cc37f3`) | Marketplace state persistence; ledger submit queue and backpressure; ZK residuals; height operator; relay payload encryption; event-loop blocking by Poseidon / SMT; history scans; unbounded Marketplace maps | Verified finding by finding (confirmed / partly confirmed / residual) and fixed with regression tests; residuals in section 6; per-finding table in REMEDIATION-COVERAGE |
| Earlier versions (v0.3.2 – v0.4.6) | — | Published remediation documents in the repository root |

## 8. Out of scope for this review

- Anything on `main` or in releases other than the pinned commit.
- The research circuit's soundness, the lab consensus and the lab economics, unless
  a finding also affects the testnet reference path (reports still welcome).
- Key custody, operating-system and hardware compromise, network-level attacks on
  a single local process.
- Legal, regulatory and tax questions; real payment rails; physical delivery.
- Performance and throughput claims (the 20k simulation is a functional test).
- The donation address `bc1qd5mffpv02peagseacxc0g8xv38j3t9xw7h9wgf` beyond its
  offline format check (it is a donation address only).

## 9. Reporting

Please report privately (contact at the top of this document). Include the commit, the file and line, a
failing test if possible, and the property that breaks. Do not publish exploit
details before a fix; do not include keys, tokens or personal data.
