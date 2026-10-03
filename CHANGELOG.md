# Changelog

## 0.5.0-public-iot-m2m (unreleased) — research labs, Poseidon protocol hash, asset model and hardening

Version 0.5.0 bundles the research-labs integration and the Poseidon protocol hash (first sections below, unchanged) with the v0.5.0 work: namespaced assets and an asset registry manifest, circuit v4 with (account, asset) state keys, API authorization hardening, remote-safe signed spends, paymaster reserve protection, a compressed sparse Merkle tree and fixes from two independent external assessments. No native token; the protocol fee (0.1%) and the Marketplace fee (3%) are unchanged.

### Security hardening (v0.5.0)

- **API authorization hardening.** Marketplace and IoT/M2M calls of the service API and the HTTP adapter are authorized only by the actor's Ed25519 signature over the canonical action message (`src/marketplace/identity.ts`). HTTP carries it in `x-uep-actor-id`, `x-uep-signature` and `x-uep-issued-at` (required for reads). A missing or invalid authorization is `401 UNAUTHORIZED`, a valid one for the wrong actor `403 FORBIDDEN`; `x-uep-caller-id` is ignored. Fund, deliver, settle and cancel pass the signed authorization to the Marketplace; `POST /v1/marketplace/orders` passes the buyer's reservation signature and idempotency key; the treasury snapshot (`GET /v1/marketplace/treasury/<asset>`) needs a signed administrator `read`. HTTP status codes follow the error code. HTTP adapter version 1.2.0. End-to-end HTTP tests cover anonymous, wrong-actor and correctly signed calls.
- `/v1/objects*`: a bearer token (`objectsToken` option, constant-time comparison) when configured; without one, only loopback hosts are served.
- **CORS:** off by default (same-origin only). `cors.allowedOrigins` or `UEP_HTTP_CORS_ORIGINS` (comma-separated) lists exact origins; `*` only if listed explicitly; credentials are never allowed. `OPTIONS` preflight answers `204`.
- **Pin verifying key.** Lab verifiers use the development verifying key pinned by SHA-256 per depth and domain (`uep-core/vectors/UEP-ZK-DEV-VK-PINS.json`; deployments set `UEP_ZK_VK_PINS_FILE`). A key carried in a message must match the pinned key (`VK_PIN_MISMATCH`); `VerifyingKeyRegistry.pin()` only accepts pinned keys.
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
- New CLI commands `uep-zk dev-vk <depth>` and `uep-zk state-index <account> <asset> <depth>`; development keys come from the fixed setup seed.

### Performance (v0.5.0)

- **Compressed sparse Merkle tree** (`src/core/smt.ts`): only non-empty leaves and branch points are stored (2n − 1 nodes for n leaves) and empty subtrees use the precomputed default hashes; roots, paths and serialization are identical to the previous tree (root-equivalence tests against the previous implementation at depths 4, 8, 32 and 254). Memory benchmark: `npm run bench:smt` (depth 254, 10,000 accounts: 19,999 stored nodes and 2.05 MiB retained, against 2,358,302 nodes and 428.45 MiB for the previous tree, about 209 times less memory, same root; insertion time is dominated by Poseidon in TypeScript and did not improve).

### Labs (v0.5.0)

- The rotating-leader lab follows the single-proposer schedule (UEP-37.6) and the digest-only aggregate proposal path; two lab files leave the known-issue list (14 remain, mostly multi-process timing). The uep37.5 state-slot collision is resolved by the v4 (account, asset) keying and the collision rejection.

### Documentation (v0.5.0)

- `docs/adr/0001-asset-model.md`: unit of account (D-1), asset model (D-3), openability and the pending ledger integration. `docs/API.md` lists the changed signatures of v0.5.0.

### Compatibility (v0.5.0)

- **Behaviour change:** asset ids are renamed (see above); pre-release format-6 snapshots with the old ids do not restore. The snapshot format number stays 6; snapshots may now contain `sender-signature` spends.
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
