# Universal Economic Protocol (UEP)
## Public Testnet Reference + Digital Marketplace

> **Public evaluation release — October 2026**  
> **Version:** `0.5.0-public-iot-m2m` (unreleased)

[![CI](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/actions/workflows/ci.yml)

UEP (Universal Economic Protocol) is a research and engineering project exploring a neutral economic protocol for exchanging **services, resources and multiple asset types** without requiring a single universal UEP currency.

This repository is the **public reproducible reference slice** of the project. It combines two deliberately separated layers:

1. **UEP TESTNET** — a deterministic, local, in-process reference implementation of the current terrestrial testnet transaction model.
2. **UEP Digital Services Marketplace** — a business-layer marketplace for listing services, reserving capacity, holding orders, validating delivery and settling marketplace fees.

The repository is intended for developers, researchers, security testers and early community participants who want to inspect the implementation, reproduce its tests, attack its assumptions and build compatible experiments.

Alongside these two layers, the repository also publishes the project's **research labs** (Rust/ZK core in `uep-core/`, consensus, node, economic and agent experiments in `src/lab/` and `src/agent/`). They are experimental, are tested by `npm run test:all`, and are not part of the testnet rules ([`docs/LABS.md`](./docs/LABS.md)).

## Origin and motivation

UEP did not start as a product plan. It started from a research question:

> *Can two parties agree on a price, exchange a service and settle it reliably when they do not share a currency, do not depend on a central payment operator, and cannot count on a fast, always-available communication link between them?*

On Earth the question is mostly about neutrality and resilience: different assets coexisting, intermittent connectivity, machines paying machines. Taken to its limit, with parties separated by minutes to hours of signal delay, it becomes a question about how economic coordination can work when a shared, low-latency clock cannot be assumed.

The project has grown step by step from that question: first a minimal state machine for notes, nullifiers and fees; then a hardened local testnet; then a Marketplace and an IoT/M2M service layer to test the model against concrete service flows; and, in parallel, research labs for zero-knowledge spends, multi-node consensus and delay-tolerant settlement. Each public step is released with its tests and its known limitations; since the first public release, independent adversarial assessments have examined each release line up to v0.4.6.

There was no predefined commercial goal. As the protocol gains capabilities, some of them could become broadly useful, for example settling machine-to-machine services or keeping local economies working under poor or delayed connectivity. These are hypotheses to be tested, not statements about what UEP does today.

### How to read the status of anything in this repository

| Label | Meaning |
|---|---|
| **Implemented (testnet)** | Code in `src/core`, `src/testnet`, `src/identity`, `src/marketplace`, `src/service/iot-m2m*` and `src/network`, covered by `npm test`. Runs only on the local, single-node, in-process testnet. |
| **Experimental (lab)** | Code in `src/lab`, `src/agent`, the service/API lab in `src/service` and `uep-core/`. Tested by `npm run test:all`, but not part of the testnet rules and without any security claim. |
| **Planned** | A roadmap milestone with deliverables and exit criteria ([`ROADMAP.md`](./ROADMAP.md)); not yet in code. |
| **Research / future vision** | A direction of inquiry, such as delay-tolerant or interplanetary settlement. No settled design, nothing operational. |

### Current status (v0.5.0)

| Item | Status |
|---|---|
| Version | `0.5.0-public-iot-m2m` (unreleased): API authorization hardening, signed spends, paymaster caps, compressed Merkle tree, circuit v4 with pinned verifying keys, namespaced asset ids and the asset registry manifest, on top of the research-labs integration and Poseidon protocol hash ([`CHANGELOG.md`](./CHANGELOG.md)). Latest GitHub Release: `v0.4.6-public-iot-m2m` |
| Tests (testnet) | protocol **96/96**, Marketplace + IoT/M2M + HTTP authorization **121/121** (includes IoT **23/23** and scale **3/3**) |
| Tests (research labs) | Rust **115** (uep-21-poseidon 7, uep-25-prototype 9, uep-26-spend-circuit 99); labs **455** tests in 96 files; 14 lab files with known issues run in a non-blocking job |
| Test everything | `npm ci && npm run test:all` (see [Quickstart](#quickstart-test-everything)) |
| Protocol hash | Poseidon over BN254 (one canonical hash for the core and the ZK circuit lab); snapshot format 7, format 6 migrated ([compatibility policy](docs/COMPATIBILITY.md)) |
| Research labs | Internal lab experiments from the project's early stage, now public as experimental code in `src/lab/`, `src/agent/` and `uep-core/`, run by `test:all`; not part of the testnet ([`docs/LABS.md`](./docs/LABS.md)) |
| Simulation | `npm run simulate:20k`: 20,000 signed, funded settlements, 0 errors, value conserved (in-process) |
| CI | Blocking: `npm run test:all` (core, Rust, labs without known issues) on Node.js 22.x and 24.x. Non-blocking: the lab files with known issues |
| Network | Local, single-node, in-process **testnet only** |
| External review | Independent adversarial assessments of each release up to v0.4.6; open items in [`PUBLIC-SECURITY-REMEDIATION-v0.4.6.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.6.md) |

Architecture by layer: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Phases and next milestones: [`ROADMAP.md`](./ROADMAP.md).

---

## 1. What UEP is trying to solve

Traditional economic networks often assume one of the following:

- one dominant currency;
- continuously connected infrastructure;
- synchronous global confirmation;
- a centralized payment processor;
- or an economic asset whose value is defined independently of the underlying service/resource.

UEP explores a different direction: an economic protocol in which **different assets and real services can coexist**, while local economic state can be processed without requiring a universal low-latency clock.

The long-term research direction includes terrestrial, delayed-network and eventually deep-space environments. Those future layers are **not represented as operational claims by this repository**.

### No native UEP token in this release

This public release does **not** introduce a native UEP token.

The design goal is to keep the network useful through real services, assets and network functions rather than introducing speculative monetary complexity before a demonstrated technical or economic need exists.

---

## 2. What is actually implemented here

### UEP TESTNET reference layer

The public testnet implements a local reference state machine with:

- deterministic account identity derived from test credentials;
- key-derived account ids and checksummed, versioned Bech32m v2 addresses (v0.4.5);
- testnet faucet;
- multi-asset testnet registry (balances per account and asset; since v0.4.7 per-asset isolation, issuer keys, policy limits and fee floors; since v0.5.0 namespaced asset ids `<namespace>/<symbol>` and a governance-signed asset registry manifest module with threshold issuer key sets, see [`docs/adr/0001-asset-model.md`](./docs/adr/0001-asset-model.md); wiring the manifest into the ledger is the next milestone);
- account and note commitments;
- nullifiers and replay protection;
- Sparse Merkle state representation;
- an append-only note-commitment Merkle tree with membership proofs (v0.4.4);
- per-account Ed25519 sender signatures and a validated, bounded pending queue (v0.4.4);
- sender / recipient / treasury balance transition;
- deterministic transaction commitments;
- deterministic transaction identifiers;
- the current testnet creator-fee rule;
- ownership checks;
- asset/network separation;
- snapshot/restore support;
- adversarial tests for replay, double spending, ownership, transaction mutation, forged identities, proof bypass, policy bypass, input-value inflation, domain replay and snapshot/restore.

The transaction path is intentionally explicit about its security boundary: **the public testnet requires sender authentication on every spend, using a deterministic development/reference MAC plus (since v0.4.4) an Ed25519 signature by the account's spend key. Since v0.4.5 the account id itself commits to that key, so the signature is verifiable without any key registry. Neither is a zero-knowledge proof or a production SNARK ceremony.**

### Digital Marketplace

The public Marketplace layer implements:

- service listings;
- provider capacity;
- order creation;
- HOLD / reservation lifecycle;
- delivery integrity hashing;
- deterministic settlement;
- Marketplace Treasury accounting;
- seller reputation;
- listing/rate controls;
- idempotent settlement;
- duplicate/replay protection;
- Paymaster-style gas sponsorship accounting;
- signed actions for every order step, with party-only order access (v0.4.4);
- buyer disputes with arbiter resolution (release / refund / split) and a timeout outcome (v0.4.4);
- IoT/M2M orders settled against telemetry signed by the machine's registered key (v0.4.4);
- authorization checks for cancellation/expiration;
- synthetic 20,000-operation load testing.

The Marketplace is intentionally a separate business layer in this release. **The repository does not claim that Marketplace settlement is already an end-to-end production transaction through the UEP consensus/ZK stack.**

### Research labs (experimental)

The labs were internal experiments during the project's early stage and are now published so that the whole project can be built and tested in one place. They import the hardened primitives from `src/core` and do not change the testnet rules. They include:

- **Rust/ZK core** (`uep-core/`): Poseidon over BN254 with an R1CS gadget, the UEP-25 reference state machine, and the UEP-26 Groth16 spend circuit with the `uep-zk` CLI (development keys from a seeded setup, no ceremony);
- **ZK bridge** (`src/lab/zk-*.ts`, `poseidon-*.ts`): calling `uep-zk` from TypeScript to prove and verify spends;
- **execution engine** with conflict scheduling and persistence;
- **node protocol and transport**: authenticated envelopes, TCP handshake, pinned verifying keys;
- **consensus experiments** (`src/lab/uep34-*` to `uep38-*`): leader election, quorum and commit certificates, BFT configuration gate, DAG dissemination, partitions and recovery, multi-leader aggregates, view change, SMT economic state on the consensus path;
- **economic labs** (`src/lab/uep-econ-*`): meaningful transactions, service settlement, escrow and holds, dispute liveness;
- **network adaptation** (`src/lab/uep-net-adapt/`): simulated links, relays and delay-tolerant bridging;
- **agents** (`src/agent/`): agent identity, owner-signed capabilities, nonce windows;
- **service/API lab** (`src/service/`): a versioned HTTP service API, storage adapters with content hashes, observability.

Some lab suites have documented known failures and run in a non-blocking CI job. Scope, commands and the known differences between the labs and the core are in [`docs/LABS.md`](./docs/LABS.md); the design notes are indexed in [`uep-core/README.md`](./uep-core/README.md).

---

## 3. Current public economic model

### UEP TESTNET creator fee

The public reference testnet retains the current experimental protocol fee rule:

`fee = max(1, floor(amount × 10 / 10,000))` for any positive amount

That corresponds to **0.1%**. Since v0.4.4 a positive transfer always pays at least **1 unit** (the minimum fee applies below 1,000 units), so small transfers no longer travel fee-free. It is a testnet protocol rule, not a promise of future commercial pricing or income.

The testnet treasury is an internal public reference account. No private key, production custody credential or personal treasury credential is included in this repository.

### Marketplace fee

The Marketplace has its own business-layer fee:

| Rule | Public preview |
|---|---:|
| Marketplace fee | **3.0%** of successfully settled service value (minimum 1 unit since v0.4.4) |
| Fee trigger | `SETTLED` only |
| Cancelled / expired order | No Marketplace fee |
| Native UEP token required | **No** |

The Marketplace Treasury allocation used by the reference implementation is:

| Treasury bucket | Allocation |
|---|---:|
| Operations | 40% |
| Risk reserve | 25% |
| Development | 20% |
| Distributable business profit | 15% |

These percentages describe the **public testnet/business model**, not a legal promise, investment return, dividend, token allocation or future commercial policy.

The Marketplace Treasury is separate from the protocol-level testnet treasury.

---

## 4. Security hardening in v0.3.2

Release v0.3.2 followed independent assessment `UEP-RR-2026-10-02-001`. The previous public alpha had critical weaknesses in its provisional hash and optional authentication path. v0.3.2 addressed them. In particular:

- the reversible/commutative algebraic placeholder is no longer the active public hash backend;
- sender authentication is required by default;
- transaction submission enforces the configured security policy rather than relying only on wallet-side checks;
- transaction commitments/TxIDs include the domain and explicit input/output boundaries;
- input-note value is checked against amount plus fee;
- Marketplace cancellation/expiration is actor-authorized;
- snapshot/restore is covered by a regression test;
- already-applied transactions cannot be overturned by a later reconciliation conflict.

The SHA-256-based backend introduced in v0.3.2 was a reference hardening backend. It has since been replaced by **Poseidon over BN254** (see §12); it is kept in `src/core/hash.ts` only as an inactive reference.

---

## 5. Security hardening in v0.4.1 – v0.5.0

These public testnet releases harden the ledger, the IoT/M2M service layer and Marketplace reservations after the independent adversarial assessments of v0.4.0 – v0.4.6. v0.4.7 adds per-asset hardening. v0.5.0 adds the API authorization hardening, signed spends, paymaster caps and the fixes from the reviews of v0.4.7; see [`CHANGELOG.md`](./CHANGELOG.md). Per-finding status and remaining limitations: [`PUBLIC-SECURITY-REMEDIATION-v0.4.6.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.6.md) (previous: [`v0.4.5`](./PUBLIC-SECURITY-REMEDIATION-v0.4.5.md), [`v0.4.4`](./PUBLIC-SECURITY-REMEDIATION-v0.4.4.md), [`v0.4.3`](./PUBLIC-SECURITY-REMEDIATION-v0.4.3.md), [`v0.4.2`](./PUBLIC-SECURITY-REMEDIATION-v0.4.2.md), [`v0.4.1`](./PUBLIC-SECURITY-REMEDIATION-v0.4.1.md)). Changed signatures are listed in [`docs/API.md`](./docs/API.md).

### Ledger

- Transaction input notes are resolved against the receiving ledger's existing unspent note set. Notes carried inside a transaction are evidence, not an issuance authority.
- The public testnet transaction format uses **one input note per transaction**, because the current envelope carries a single nullifier. A spend needs one note that covers amount plus fee; multi-input aggregation is intentionally not claimed until a nullifier vector is introduced. **v0.4.7:** `preparePayment()` + `submitBatch()` pay one recipient from several notes as an atomic batch of single-input spends (all or none, one fee per part).
- **v0.4.2:** outputs are bound to the transaction: output 0 pays exactly `amount` to the recipient, and the optional output 1 returns exactly `input − amount − fee` to the sender. The transaction nonce must be the consumed note's nonce, so the nullifier is anchored to that note. Sender, recipient and treasury must be distinct accounts.
- **v0.4.3:** snapshots are signed with **Ed25519** (`node:crypto`, no new dependencies) instead of a shared HMAC secret. `UepLedger.restore(snapshot, trust)` takes only **public keys**; verifiers never need a private key. An optional **k-of-n threshold** (for example 2-of-3) requires `k` valid signatures from distinct listed authorities; the default is 1-of-1 for the local testnet.
- **v0.4.3:** snapshots form a **hash chain** (`sequence`, `prevSnapshotHash`). Restore can be pinned to a known previous snapshot hash or to a checkpoint (`checkpointOf()`), and `UepLedger.restoreChain()` verifies an ordered series; a reordered, rolled-back or rewritten history is rejected even when it is correctly signed.
- **v0.4.3:** every faucet mint is signed by a **dedicated faucet (mint) key** that must differ from every snapshot key. Restore rejects unsigned mints, mints signed by any other key (including a snapshot key) and notes that are neither a signed mint nor a transaction output; supply is derived from the signed mints. The snapshot authority therefore cannot invent issuance.
- v0.4.2 invariants still apply on restore: state and nullifier roots, nullifier seen-set, note openings and nonces, in-order transaction replay under the same rules as `submit()`, spent flags and per-account balances against unspent notes (plus treasury fee income). Snapshot **format version 7** is current since the ledger records its block height (ADR 0002). Format 6 snapshots (Poseidon protocol hash) are migrated to 7 on restore (height 0), through the migration registry in `docs/COMPATIBILITY.md`. Format 5 and older are rejected with `INVALID_SNAPSHOT_VERSION` and the reason; their testnet state must be re-created (see the migration notes below).
- Pending reconciliation never settles or applies a queued spend: invalid envelopes are rejected, valid ones stay queued (`LOCAL_VALID`, flagged on conflict) until applied through `submit()`.
- **v0.4.4:** every spend carries an Ed25519 **sender signature** by the account's spend key (`deriveSpendKey(secret, salt)`). `submit()` requires it even when the development ownership proof is disabled.
- **v0.4.5:** **key-derived accounts.** The account id commits to the spend public key (`0x02 ‖ SHA-256(tag ‖ key)[0..31]`), and every note owner is such an id. A spend reveals the key and signs the envelope. Any replica checks that the key hashes to the sender and to the input note's owner, without the sender's secret and **without a key registry**: the v0.4.4 trust-on-snapshot spend-key registry is removed. Restore checks that every note owner is a key-derived id and that every committed spend's key matches its sender and input owner.
- **v0.4.4:** the **pending queue is validated at entry**. A queued spend must be signed by the sender's spend key (since v0.4.5, the key its account id commits to), consume notes that exist unspent in the local ledger (same `checkSpendShape()` rules as `submit()`) and carry a valid membership proof. The queue is bounded (`maxPendingTransactions`, default 1024) and de-duplicated, and `restore()` re-validates every pending entry.
- **v0.4.4:** an append-only **note-commitment Merkle tree** (depth 32). Its root and size are part of state and snapshots; every spend proves membership of its input against a historical root (`tx.inputMembership`), and restore rebuilds the tree, checks the root, and re-checks each replayed spend's proof and sender signature. A replica can verify that a note exists from the root alone (`verifyNoteMembership`).

### Address format and migration (v0.4.5)

Accounts are identified by **v2 addresses** (UEP-ADDR-002):

```text
address    = Bech32m(hrp = "uep", version ‖ networkTag ‖ keyHash)   e.g. uep1qgkqzr27…  (68 characters)
version    = 0x02
networkTag = SHA-256("UEP-ADDR-NETWORK-v2\n" ‖ networkId)[0..4]
keyHash    = SHA-256("UEP-ACCOUNT-KEY-v2\n" ‖ raw Ed25519 spend public key)[0..31]
accountId  = 0x02 ‖ keyHash   (the ledger's note owner / sender / recipient id)
```

- The **Bech32m** checksum (BIP-350) detects typos.
- The **version byte** allows future formats.
- The **network tag** stops an address for one network from decoding on another.

`encodeAccountAddress`, `decodeAccountAddress` / `parseAccountAddress` (errors `ADDRESS_CHECKSUM`, `ADDRESS_VERSION`, `ADDRESS_NETWORK`, `ADDRESS_HRP`, `ADDRESS_LENGTH`, `ADDRESS_FORMAT`, `ADDRESS_LEGACY_V1`), `ledger.addressOf()`, and `faucet()` / `prepareSpend()` accept addresses.

**Migration note.** v1 addresses (`uep:<network>:<hex>`, accounts derived as `H(secret, salt)`) are **invalid** from v0.4.5 on. The same mnemonic derives a new key-derived account and address. Testnet state, snapshots and vaults created with v0.4.4 or earlier cannot be carried over: re-create the testnet state (faucet the new addresses again). This is a testnet; no value migrates.

**Migration note (Poseidon hash, snapshot format 6).** Note commitments, nullifiers, the state and nullifier roots and transaction ids are now computed with Poseidon over BN254. Snapshots in format 5 or earlier are rejected (`INVALID_SNAPSHOT_VERSION`): re-create the testnet state. Mnemonics, spend keys, account ids and `uep1…` addresses do not change.

**Residual trust model (testnet):** whoever holds the snapshot authority private keys controls what their node signs, and whoever holds the faucet key controls testnet issuance on that node. Signatures, the hash chain and checkpoints make tampering by anyone else detectable and keep the two roles separate; they do not make a key holder honest. This is the trust model of the local testnet, not production consensus.

### Marketplace and IoT/M2M

- **v0.4.3:** reservations cost something. Only identities with a **registered Ed25519 key** (`registerIdentity`) can reserve, and every reservation carries the buyer's signature (`signReservation`). The **deposit** (default 1% of gross, minimum 1 unit; `reservationDeposit` / `reservationDepositBps`) is **locked from the buyer's marketplace balance at `reserve()`**; without funds there is no reservation. Since v0.4.5 a configured deposit below 1 unit is refused (`RESERVATION_DEPOSIT_BELOW_MINIMUM`) unless the explicitly named test-only flag `testOnlyAllowZeroReservationDeposit` is set.
- When the order is funded, the deposit **counts toward the payment** (`fundOrder(orderId, order.fundingDue)`). An unfunded reservation that **expires** forfeits the deposit to the provider. A signed **buyer cancellation** within `cancellationGraceMs` (default 2 minutes) refunds it; after the window it goes to the provider. Provider or admin cancellation, and expiry of a funded but undelivered order, refund the buyer in full.
- Per-identity limit on concurrent open reservations (`maxActiveReservationsPerIdentity`, default 8) and a short TTL (`reservationTtlHeights`, default 120 heights, 10 minutes at the 5 s reference block time; since v0.5.0 every window is measured in block heights, see `docs/adr/0002-deterministic-transitions.md`); `expire()` is only possible after the TTL. `valueAccounting(asset)` checks conservation across every deposit path.
- IoT `requestService()` requires the buyer's reservation signature, and `hold()` funds the remainder after the locked deposit, including any sponsored gas fee.
- **v0.4.4:** every order action is signed (`signAction`; buyer, provider, admin and arbiter alike), including funding: only the buyer's signature can move the buyer's balance into escrow. Providers must be registered identities; the admin and the arbiter are verified against configured public keys (`adminPublicKey`, `settlementArbiterPublicKey`). Reading or listing an order requires being one of its parties or the admin, with a short-lived signed read authorization.
- **v0.4.5:** a marketplace or IoT identity may be named by its ledger **v2 address**. It must then register the spend key that address commits to (`IDENTITY_ADDRESS_KEY_MISMATCH`), so an address-named buyer or provider is the same key holder as the ledger account. Plain identity names keep working.
- **v0.4.4:** a **dispute flow** with defined outcomes. The buyer can open a dispute within the delivery dispute window; the arbiter resolves it as `RELEASE`, `REFUND_BUYER` or `SPLIT`; the provider can concede a refund; an unresolved dispute falls back to a configurable timeout outcome (default: refund the buyer). Every outcome moves the escrow exactly once, and `valueAccounting()` stays conserved.
- **v0.4.4:** **IoT telemetry is always signed** by the machine's registered Ed25519 key (machines cannot be registered without one), with monotonic sequence numbers and nonce anti-replay. An IoT order is released only against verified telemetry that was delivered for that order and reports the full contracted quantity; a shortfall goes to a dispute. Simulations sign with test machine keys.
- **v0.4.6:** a dispute timeout configured as `RELEASE` runs the same category guard. An IoT order without verified telemetry for its full quantity is **refunded to the buyer** instead of paid (`TIMEOUT_REFUND_UNVERIFIED`). The arbiter's explicit release stays final, and its record says whether the guard passed (`categoryGuard: "ARBITER_OVERRIDE"` otherwise).
- **v0.4.7:** balances, locked deposits and held escrow are kept **per asset and identity**, and every composite key is structural. Asset and identity ids are validated. Optional: an asset-registry mode (`assetRegistryNetworkId`), per-asset minimum fees and deposits, and administrator-signed credits (`requireSignedCredits`).
- **v0.5.0:** the HTTP/service API lab **fails closed**: Marketplace and IoT calls need a signed actor (`x-uep-actor-id`, `x-uep-signature`, `x-uep-issued-at` for reads); a missing or invalid signature returns 401 and a valid signer without the right role 403. The treasury read needs an administrator signature, `/v1/objects*` needs a token outside loopback, and CORS is off unless origins are configured (`UEP_HTTP_CORS_ORIGINS`). Ledger spends are authorized by the **sender signature** by default and can be submitted without secrets; the Marketplace paymaster has per-actor and per-order caps and expires its own reservations.
- **v0.4.6:** **capacity is returned exactly once** when an order closes without consuming it: in full on cancel, expiry or a refund without execution evidence, and the unpaid units of a split. Units executed per verified IoT telemetry stay consumed. `available` never exceeds `capacity`, and `capacityAccounting(listingId)` checks `capacity = available + reserved + consumed`.

These controls are testnet protections, not a claim of production consensus or production ZK security.

### Snapshot example

```ts
import { generateEd25519KeyPair } from "./src/core/ed25519.ts";
import { UepLedger, checkpointOf } from "./src/testnet/ledger.ts";

// Authority node: holds its private keys (keep them outside source control).
const snapshotKey = generateEd25519KeyPair();
const faucetKey = generateEd25519KeyPair(); // must differ from every snapshot key
const ledger = new UepLedger({ networkId, domainId, connected: true, allowFaucet: true,
  snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey });
const snapshot = ledger.snapshot();

// Verifier: public keys only, optionally pinned to a known checkpoint.
const trust = { authorities: [snapshotKey.publicKeyHex], threshold: 1, faucetPublicKeys: [faucetKey.publicKeyHex] };
const restored = UepLedger.restore(snapshot, trust);
const next = UepLedger.restore(ledger.snapshot(), { ...trust, checkpoint: checkpointOf(snapshot) });
```

Do not commit private keys or any real deployment secret.

---

## 6. Important status: what this repository is NOT

This repository is **not** a production financial network.

It does not provide:

- a live public UEP network;
- production custody of money or crypto-assets;
- a regulated payment service;
- a production banking or settlement service;
- a production consensus deployment;
- a production P2P network;
- a production ZK proving/verifying ceremony;
- a production verifying-key registry;
- audited smart contracts;
- a guarantee of cryptographic security beyond the documented reference implementation;
- a guarantee of Internet-scale TPS;
- a guarantee of cross-planetary settlement;
- physical energy, compute, water, oxygen or other resource delivery merely because an asset identifier exists;
- regulatory approval or legal authorization.

**Do not use this repository to custody real customer funds or represent testnet balances as real-world assets.**

---

## 7. Reproducibility

### Requirements

- Node.js **22.6 or newer**
- Git
- Rust **1.85** (`cargo`), only for the research labs in `npm run test:all` (`npm test` does not need it)

The public reference layer intentionally avoids requiring the large private development workspace or a production proving ceremony.

### Quickstart: test everything

```bash
git clone https://github.com/UEPceo/UEP-Universal-Economic-Protocol.git
cd UEP-Universal-Economic-Protocol
npm ci
npm run test:all
```

`npm run test:all` runs, in order and stopping at the first failure:

1. `npm run lint:determinism` and `npm run check:snapshot-compat`: no clock or external call in transitions (ADR 0002); no snapshot format change without a migration step and golden fixtures ([`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md));
2. `npm test`: protocol/testnet (126, including the golden snapshot fixtures), Marketplace + IoT/M2M + HTTP authorization + compatibility shims (145, including the 29 IoT and 3 scale tests);
3. `npm run smoke:testnet`: prints `SMOKE OK`;
4. `npm run quickstart`: the first-transaction example;
5. `npm run simulate:20k`: 20,000 in-process settlements, `errors: 0`, `valueConserved: true`;
6. `npm run test:rust`: Rust tests of the research crates in `uep-core/` (Poseidon, prototype, UEP-26 spend circuit);
7. `npm run build:uep-zk`: builds the research Groth16 prover `uep-zk` from source into `uep-core/target/`;
8. `npm run test:lab`: the research labs in `src/lab/`, `src/agent/` and the service/API lab in `src/service/` (see [`docs/LABS.md`](./docs/LABS.md)).

Steps 1–5 need no network access and take a few minutes, depending on the machine (the protocol suite alone takes about a minute, because Poseidon runs in TypeScript). Steps 6–8 download Rust crates on the first build and take longer. No private keys are needed: the lab clusters generate throwaway keys for each run. CI runs the same command on Node.js 22.x and 24.x as a blocking job, and runs the lab files with known issues (`scripts/lab-known-issues.json`) in a separate non-blocking job, so the badge reflects the core. Expected results: [`docs/REPRODUCIBILITY.md`](./docs/REPRODUCIBILITY.md).

### Minimal reproducible verification

```bash
npm ci
npm test
npm run example
```

The security regression suite is part of `npm test`. It covers the public hardening release, including ordered commitments, sender authentication, policy enforcement, input-value binding, domain separation and snapshot/restore.

### Run only the protocol/testnet tests

```bash
npm run test:protocol
```

### Run only Marketplace tests (including IoT/M2M)

```bash
npm run test:marketplace
```

### Run only IoT/M2M tests

```bash
npm run test:iot
```

### Run the testnet smoke test

```bash
npm run smoke:testnet
```

The smoke test performs:

```text
identity
   ↓
faucet
   ↓
prepare spend
   ↓
commitment / ownership / fee checks
   ↓
submit
   ↓
nullifier insertion
   ↓
state update
   ↓
balance verification
```

It prints the resulting transaction ID, sender, recipient, amount, fee, nullifier and state root.

### Reproduce the first-transaction example

```bash
npm run quickstart
```

The example prints a structured record containing the transaction identifiers and final state root.

### Marketplace synthetic load test

```bash
npm run simulate:20k
```

This is an **in-process deterministic simulation**. It is not a claim that UEP can process 20,000 real Internet users or transactions per second.

---

## 8. Architecture and repository layout

UEP is described as fourteen layers (A. core protocol to N. public economic network). [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) has the diagrams and a status table that marks each layer as *Implemented (testnet)*, *Partial*, *Design* or *Future*. In short: the core protocol, ledger, Marketplace, IoT/M2M and local testnet are implemented on the testnet; cryptography/ZK, the service plane and identity are partial; events/storage/API, SDK and the public economy are design; consensus, node infrastructure and interplanetary extensions are future work.

Repository layout:

```text
.
├── README.md
├── LICENSE
├── NOTICE
├── SECURITY.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── PUBLIC-SCOPE.md
├── CHANGELOG.md
├── ROADMAP.md                # phases 0–9, goals, deliverables, exit criteria
├── PUBLIC-SECURITY-REMEDIATION-v0.4.1.md
├── PUBLIC-SECURITY-REMEDIATION-v0.4.2.md
├── PUBLIC-SECURITY-REMEDIATION-v0.4.3.md
├── PUBLIC-SECURITY-REMEDIATION-v0.4.4.md
├── PUBLIC-SECURITY-REMEDIATION-v0.4.5.md
├── PUBLIC-SECURITY-REMEDIATION-v0.4.6.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── .gitignore
├── .gitattributes
├── .github/workflows/ci.yml  # CI: npm run test:all (Node 22.x / 24.x) + non-blocking known-issue labs
├── .github/ISSUE_TEMPLATE/   # bug report / feature request forms; security goes to SECURITY.md
├── .github/pull_request_template.md
│
├── src/
│   ├── core/                 # Minimal public economic/cryptographic primitives
│   │   ├── field.ts
│   │   ├── poseidon.ts       # active protocol hash: Poseidon over BN254 (+ poseidon-bn254-params.ts)
│   │   ├── hash.ts           # hash backend interface; SHA-256 backend kept as inactive reference
│   │   ├── encoding.ts
│   │   ├── fee.ts
│   │   ├── note.ts
│   │   ├── nullifier.ts
│   │   ├── smt.ts
│   │   ├── transition.ts
│   │   ├── transaction.ts
│   │   ├── reconciliation.ts
│   │   ├── address.ts        # v0.4.5: Bech32m v2 addresses (UEP-ADDR-002)
│   │   ├── assets.ts         # network asset templates, namespaced asset ids (v0.5.0)
│   │   ├── asset-registry.ts # v0.5.0: signed asset registry manifest, issuer key sets (ADR 0001)
│   │   ├── composite-key.ts  # injective composite keys for per-asset maps (v0.4.7)
│   │   ├── security-policy.ts
│   │   ├── ed25519.ts        # Ed25519 helpers (node:crypto) for snapshots, mints, buyer signatures
│   │   ├── spend-key.ts      # spend keys, key-derived account ids (v0.4.5), sender signatures
│   │   ├── note-tree.ts      # v0.4.4: note-commitment Merkle tree and membership proofs
│   │   ├── spend-proof.ts
│   │   ├── status.ts
│   │   ├── zk-witness-contract.ts
│   │   ├── index.ts
│   │   ├── poseidon.test.ts
│   │   └── uep-smt-key-hardening.test.ts
│   │
│   ├── identity/             # Deterministic test identities
│   ├── network/              # Public TESTNET profile only
│   ├── testnet/              # Local UEP ledger reference implementation + tests
│   ├── marketplace/          # Marketplace business layer (signed actions, disputes) + tests
│   ├── lab/                  # Research labs (experimental, not the testnet), see docs/LABS.md
│   ├── agent/                # Research lab: agent foundation
│   └── service/              # Content integrity + IoT/M2M service layer (+ service/API research lab)
│       ├── content-hash.ts
│       ├── iot-m2m.ts
│       ├── iot-m2m-codec.ts
│       ├── iot-m2m.test.ts
│       ├── iot-testkit.ts    # test/simulation helpers (signed IoT flows)
│       └── index.ts
│
├── examples/
│   └── first-transaction.ts
│
├── scripts/
│   ├── testnet-smoke.ts
│   ├── marketplace-20k-simulation.mjs
│   ├── test-rust.sh / build-uep-zk.sh   # research Rust crates and uep-zk prover
│   ├── test-lab.mjs                     # research lab runner (+ lab-known-issues.json)
│   └── zk-local-smoke.mjs               # npm run smoke:zk (D=4 setup + prove + verify)
│
├── uep-core/                 # Research labs (experimental), see uep-core/README.md
│   ├── uep-21-poseidon/      # Poseidon BN254 + R1CS gadget (Rust)
│   ├── uep-25-prototype/     # UEP-25 reference state machine (Rust)
│   ├── uep-26-spend-circuit/ # UEP-26 Groth16 spend circuit and uep-zk CLI (Rust, development keys)
│   ├── uep-23-state-transition/, uep-24-atomic/   # historical scaffolds, not built or tested
│   ├── uep-32-e2e-evidence/  # lab evidence notes
│   ├── vectors/              # Poseidon and SMT golden vectors
│   ├── benchmarks/           # recorded lab benchmark outputs
│   ├── docs/                 # lab API, storage and observability notes
│   └── UEP-*.md              # lab design notes by milestone
│
└── docs/
    ├── API.md            # changed public signatures (v0.4.3 – v0.5.0)
    ├── adr/              # architecture decision records (0001: asset model)
    ├── ARCHITECTURE.md   # layers A–N, status table, diagrams
    ├── THREAT-MODEL.md
    ├── REPRODUCIBILITY.md
    └── LABS.md           # research labs: scope, how to run, known differences from the core
```

The structure is intentionally much smaller than the internal development workspace.

---

## 9. Transaction model

At the public reference layer, a testnet spend conceptually follows:

```text
Identity
   │
   ├── Spend key = Ed25519(seed = H(secret, salt))
   ├── Account ID = 0x02 ‖ H(spend public key)      (v0.4.5)
   ├── Address = Bech32m v2 (version, network tag, key hash)
   │
   └── Nullifier = H(secret, nonce)
   │
   ▼
Spend preparation
   │
   ├── select unspent notes
   ├── calculate fee
   ├── calculate sender debit
   ├── construct recipient output
   ├── construct change output
   └── construct transaction commitment
   │
   ▼
Submission checks
   │
   ├── network binding
   ├── replay protection
   ├── nullifier protection
   ├── transaction commitment
   ├── TxID derivation
   ├── fee policy
   ├── asset registry
   ├── ownership / development spend proof
   ├── sender signature (key hashes to the sender and input-note owner)
   ├── input note membership (note-commitment tree)
   └── note commitment validation
   │
   ▼
State transition
   │
   ├── sender balance decreases
   ├── recipient balance increases
   ├── treasury fee increases
   ├── input note(s) become spent
   ├── output note(s) are added
   └── state/nullifier/note-commitment roots change
```

This is a **reference local execution model**, not a claim of globally finalized consensus.

---

## 10. Marketplace lifecycle

The Marketplace business layer is intentionally understandable independently of consensus:

```text
Provider
  │
  ▼
LISTING
  │
  ▼
ORDER
  │
  ▼
HOLD / RESERVATION
  │
  ├──────────────► CANCEL / EXPIRE
  │
  ▼
DELIVERY (signed delivery hash)
  │
  ▼
CONTENT / DELIVERY VALIDATION
  │
  ├──────────────► DISPUTE (buyer, within the window)
  │                  │
  │                  ├── RELEASE ──────► SETTLEMENT
  │                  ├── SPLIT ────────► provider share − fee, rest to buyer
  │                  └── REFUND_BUYER ─► REFUNDED (no fee)
  ▼
SETTLEMENT (buyer, or provider after the window, or arbiter)
  │
  ├── provider payout
  └── 3% Marketplace fee (min. 1 unit) → Marketplace Treasury
```

The design deliberately charges the Marketplace fee only at successful settlement. Failed, cancelled or expired orders do not become Marketplace fee income.

Since v0.4.3 the reservation step is signed and funded: a registered buyer signs the reservation, the reservation deposit is locked from the buyer's balance, and funding pays the remainder (`grossAmount + gasFee − deposit`). The deposit is refunded on a buyer cancellation within the grace window and on provider/admin cancellation; it goes to the provider when an unfunded reservation expires or the buyer cancels after the grace window. A funded order that expires undelivered is refunded in full.

Since v0.4.4 every step is a signed action, and only the order's parties (or the admin) can read it. After delivery the buyer can open a dispute within `deliveryDisputeWindowMs`. The arbiter resolves it (release, refund or split); the provider can concede a refund; and if nobody resolves it within `disputeResolutionWindowMs`, the configured timeout outcome applies (default: refund the buyer). A split charges the Marketplace fee only on the provider's share; a refund charges none.

Since v0.4.6 a `RELEASE` timeout pays only when the category guard passes (IoT: verified telemetry for the full quantity) and otherwise refunds the buyer. Unconsumed capacity returns to the listing once: on cancel or expiry, on a refund, and for the unpaid units of a split. Units executed per verified IoT telemetry are not returned.

---

## 11. Security philosophy

The public project follows a simple rule:

> **A passing test is evidence of a tested property, not proof that the whole protocol is secure.**

The public suite therefore emphasizes negative cases as well as successful paths:

- replay;
- double spending;
- ownership forgery;
- transaction mutation;
- asset mismatch;
- capacity exhaustion;
- duplicate settlement;
- unauthorized operations;
- delivery tampering;
- Paymaster replay and reserve accounting;
- Marketplace fee accounting.

Known limitations are documented rather than hidden.

---

## 12. ZK status

This public release must not be interpreted as a production ZK network.

The public testnet transaction path uses the **development/reference spend-MAC mechanism** so that the transaction flow is reproducible without distributing a production proving ceremony or claiming a production verifier.

The project's ZK research (the UEP-26 spend circuit, the `uep-zk` prover and the TypeScript bridge) is published as experimental lab code (see below). No production trusted-setup ceremony has been performed, so there are no production proving or verification keys. The following are intentionally **not published here**:

- ceremony secrets or any future production key material;
- private proving infrastructure;
- internal ZK worker deployment configuration;
- confidential assessment material.

**Protocol hash.** The testnet core hashes note commitments, nullifiers and the sparse Merkle tree with **Poseidon over BN254** (x^5, t = 3, 8 full + 57 partial rounds, circomlib-compatible constants; `src/core/poseidon.ts`), checked against the `uep-core/vectors` test vectors. It is the same hash the research spend circuit uses, so there is one canonical protocol hash. This changes commitments, nullifiers and roots (snapshot format 6); account ids and addresses are unchanged. Using a circuit-friendly hash is not a production ZK claim.

The research Groth16 spend circuit (UEP-26) and its TypeScript bridge are published as **labs** under `uep-core/` and `src/lab/` (see [`docs/LABS.md`](./docs/LABS.md)). They use development keys generated from fixed seeds on each run, have no trusted setup, and do not provide production soundness. They are not used by the testnet transaction path.

If a future public release reaches a production-cryptographic milestone, it should be published as a separately reviewed and versioned cryptographic release rather than silently upgrading the claims of this repository.

---

## 13. Multi-node and interplanetary status

UEP investigates multi-node consensus, delayed networking, DTN-style transport and interplanetary reconciliation.

Those areas are **research tracks**, not features that this repository claims to provide as a live network. The multi-node consensus experiments (leader election, quorum and commit certificates, BFT configuration gate, DAG dissemination, partitions and recovery, view change) and a simulated network-adaptation / delay-tolerant bridging lab are published in `src/lab/`. They run as in-process simulations or as local processes and TCP connections on one machine (see [`docs/LABS.md`](./docs/LABS.md)); they are not the testnet and not a deployed network.

In particular:

- `GLOBAL` is not a live public endpoint in this release;
- no public node bootstrap credentials are included;
- no planetary network is connected;
- no Earth–Mars settlement guarantee is made;
- no deep-space communication channel is implemented here;
- an asset named for energy, compute, data or another resource does not itself prove physical delivery or ownership of that resource.

---

## 14. What has deliberately been removed from the public release

The public repository does **not** contain the internal master workspace, including material such as:

- private credentials and secrets;
- `.env` or deployment credentials;
- production or ceremony keys;
- internal endpoints and infrastructure configuration;
- private audit reports;
- internal research/critic work products;
- Grok/agent operational prompts and private workflow files;
- private PWA/authentication infrastructure;
- internal screenshots and development artifacts;
- experimental consensus branches that have not been reviewed for publication (the reviewed ones are in `src/lab/`, see [`docs/LABS.md`](./docs/LABS.md));
- private deployment tooling;
- unrelated application code.

See [`PUBLIC-SCOPE.md`](./PUBLIC-SCOPE.md) for the explicit publication boundary.

---

## 15. How to contribute

Security findings, reproducibility problems, implementation bugs and protocol questions are welcome. [`ROADMAP.md`](./ROADMAP.md) shows where help is most useful right now.

Please read:

- [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- [`SECURITY.md`](./SECURITY.md)
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)

Questions and ideas are welcome in [GitHub Discussions](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/discussions). Newcomers can start with issues labelled [`good first issue`](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/labels/good%20first%20issue). Report vulnerabilities privately as described in `SECURITY.md`, never in a public issue.

Do not publish private keys, credentials, personal data, customer information or undisclosed exploit material in an issue or pull request.

---

## 16. Research transparency

UEP is deliberately developed using an adversarial engineering process:

```text
DESIGN → IMPLEMENT → TEST → ATTACK → MEASURE → CORRECT → DOCUMENT
```

A public release therefore documents limitations even when doing so makes the project look less mature. That is intentional: the objective is for independent developers to understand **what is real, what is simulated, and what remains an open research problem**.

---

## 17. Roadmap

The full roadmap is in [`ROADMAP.md`](./ROADMAP.md). Its year buckets are goals, not commitments.

| Phase | Status |
|---|---|
| 0. Foundation | Done |
| 1. Hardened public testnet | Closing (v0.4.1 – v0.5.0) |
| Multi-asset | In progress: per-asset hardening in v0.4.7; unit and asset model decided (ADR 0001) and the signed asset registry manifest in v0.5.0; ledger integration next |
| 2. Service economy | In progress: event bus, storage and evidence, API, IoT gateway, SDK, sandbox, simulators |
| 3. Public developer platform | Planned |
| 4. Multi-node testnet | Planned |
| 5. Public testnet | Planned |
| 6 – 9. Economic network, production protocol, autonomous infrastructure, interplanetary network | Future / research |

A future feature should not be considered part of the public protocol merely because it exists in an internal branch or research document.

---

## 18. Test wallet seeds and BIP-39

All BIP-39 recovery phrases used by the public examples and tests are generated at runtime with the platform cryptographic random generator. No fixed mnemonic, private key, seed phrase or personal wallet credential is embedded in this repository. Test identities are disposable testnet identities and must never be funded with real-world value.

A review of this repository's source found no hard-coded BIP-39 mnemonic or personal wallet seed. Historical use outside the repository cannot be established from source code alone; the project therefore makes no claim about any seed that may have existed in an earlier private environment.

---

## 19. License and acceptable use

This repository is released under the **Apache License 2.0 (Apache-2.0)**. It is a permissive open-source license that permits use, modification, distribution and commercial use subject to its terms. The repository remains a testnet/reference implementation: publication under Apache-2.0 does not imply that UEP is production-ready, that testnet assets have real-world value, or that any separate UEP trademark, service, production credential or unpublished project material is licensed.

Read the complete terms in [`LICENSE`](./LICENSE) before using the code.

---

## 20. Disclaimer

This software is experimental. It is provided for research, evaluation and testing purposes. No representation is made that the implementation is secure, fault tolerant, economically viable, legally compliant in every jurisdiction, or suitable for production use.

Nothing in this repository constitutes an offer, solicitation, investment product, payment service, financial advice, custody service or guarantee of value.

---

## 21. Project principle

UEP is being developed around a simple principle:

> **Build useful economic infrastructure first; introduce complexity only when a demonstrated technical or economic need justifies it.**

That principle is why this public release contains a reproducible testnet and a real-service Marketplace model, while deliberately avoiding a speculative native token and avoiding claims that the current research stack is already a finished global or interplanetary financial network.

---

## 22. Supporting the project

UEP is an independent research project. If you want to support its development, you can send a voluntary Bitcoin donation to:

```text
bc1qd5mffpv02peagseacxc0g8xv38j3t9xw7h9wgf
```

**Bitcoin (BTC) mainnet only.** Do not send other assets or networks to this address. Always double-check the address before sending.

Donations are voluntary gifts to support research and development. They are **not** an investment, purchase, pre-sale, token allocation, equity, loan or any other financial product, and they do not grant any right to returns, profits, governance, refunds, testnet balances or future UEP assets. This address is unrelated to the testnet and Marketplace treasuries described above.

For larger funding, grants or partnerships, please get in touch at the contact address below.

Project contact: uep.dev@proton.me
