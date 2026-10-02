# Universal Economic Protocol (UEP)
## Public Testnet Reference + Digital Marketplace

> **Public evaluation release — October 2026**  
> **Version:** `0.4.3-public-iot-m2m`

[![CI](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/actions/workflows/ci.yml)

UEP (Universal Economic Protocol) is a research and engineering project exploring a neutral economic protocol for exchanging **services, resources and multiple asset types** without requiring a single universal UEP currency.

This repository is the **public reproducible reference slice** of the project. It combines two deliberately separated layers:

1. **UEP TESTNET** — a deterministic, local, in-process reference implementation of the current terrestrial testnet transaction model.
2. **UEP Digital Services Marketplace** — a business-layer marketplace for listing services, reserving capacity, holding orders, validating delivery and settling marketplace fees.

The repository is intended for developers, researchers, security testers and early community participants who want to inspect the implementation, reproduce its tests, attack its assumptions and build compatible experiments.

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
- testnet faucet;
- multi-asset testnet registry;
- account and note commitments;
- nullifiers and replay protection;
- Sparse Merkle state representation;
- sender / recipient / treasury balance transition;
- deterministic transaction commitments;
- deterministic transaction identifiers;
- the current testnet creator-fee rule;
- ownership checks;
- asset/network separation;
- snapshot/restore support;
- adversarial tests for replay, double spending, ownership, transaction mutation, forged identities, proof bypass, policy bypass, input-value inflation, domain replay and snapshot/restore.

The transaction path is intentionally explicit about its security boundary: **the public testnet requires sender authentication on every spend, using a deterministic development/reference MAC. This is not a zero-knowledge proof and is not a production SNARK ceremony.**

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
- authorization checks for cancellation/expiration;
- synthetic 20,000-operation load testing.

The Marketplace is intentionally a separate business layer in this release. **The repository does not claim that Marketplace settlement is already an end-to-end production transaction through the UEP consensus/ZK stack.**

---

## 3. Current public economic model

### UEP TESTNET creator fee

The public reference testnet retains the current experimental protocol fee rule:

`fee = floor(amount × 10 / 10,000)`

That corresponds to **0.1%**, subject to the integer floor. It is a testnet protocol rule, not a promise of future commercial pricing or income.

The testnet treasury is an internal public reference account. No private key, production custody credential or personal treasury credential is included in this repository.

### Marketplace fee

The Marketplace has its own business-layer fee:

| Rule | Public preview |
|---|---:|
| Marketplace fee | **3.0%** of successfully settled service value |
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

This release follows external review `UEP-RR-2026-10-02-001`. The previous public alpha had critical weaknesses in its provisional hash and optional authentication path. They are addressed in this release. In particular:

- the reversible/commutative algebraic placeholder is no longer the active public hash backend;
- sender authentication is required by default;
- transaction submission enforces the configured security policy rather than relying only on wallet-side checks;
- transaction commitments/TxIDs include the domain and explicit input/output boundaries;
- input-note value is checked against amount plus fee;
- Marketplace cancellation/expiration is actor-authorized;
- snapshot/restore is covered by a regression test;
- already-applied transactions cannot be overturned by a later reconciliation conflict.

The active public hash is a **reference hardening backend**, not a claim that production UEP ZK circuits will use SHA-256. Production cryptographic migration remains a separate protocol milestone.

---

## 5. Security hardening in v0.4.1 – v0.4.3

These public testnet releases harden the ledger, the IoT/M2M service layer and Marketplace reservations after the external reviews of v0.4.0 and v0.4.1. Per-finding status and remaining limitations: [`PUBLIC-SECURITY-REMEDIATION-v0.4.3.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.3.md) (previous: [`v0.4.2`](./PUBLIC-SECURITY-REMEDIATION-v0.4.2.md), [`v0.4.1`](./PUBLIC-SECURITY-REMEDIATION-v0.4.1.md)). Changed signatures are listed in [`docs/API.md`](./docs/API.md).

### Ledger

- Transaction input notes are resolved against the receiving ledger's existing unspent note set. Notes carried inside a transaction are evidence, not an issuance authority.
- The public testnet transaction format uses **one input note per transaction**, because the current envelope carries a single nullifier. A spend needs one note that covers amount plus fee; multi-input aggregation is intentionally not claimed until a nullifier vector is introduced.
- **v0.4.2:** outputs are bound to the transaction: output 0 pays exactly `amount` to the recipient, and the optional output 1 returns exactly `input − amount − fee` to the sender. The transaction nonce must be the consumed note's nonce, so the nullifier is anchored to that note. Sender, recipient and treasury must be distinct accounts.
- **v0.4.3:** snapshots are signed with **Ed25519** (`node:crypto`, no new dependencies) instead of a shared HMAC secret. `UepLedger.restore(snapshot, trust)` takes only **public keys**; verifiers never need a private key. An optional **k-of-n threshold** (for example 2-of-3) requires `k` valid signatures from distinct listed authorities; the default is 1-of-1 for the local testnet.
- **v0.4.3:** snapshots form a **hash chain** (`sequence`, `prevSnapshotHash`). Restore can be pinned to a known previous snapshot hash or to a checkpoint (`checkpointOf()`), and `UepLedger.restoreChain()` verifies an ordered series; a reordered, rolled-back or rewritten history is rejected even when it is correctly signed.
- **v0.4.3:** every faucet mint is signed by a **dedicated faucet (mint) key** that must differ from every snapshot key. Restore rejects unsigned mints, mints signed by any other key (including a snapshot key) and notes that are neither a signed mint nor a transaction output; supply is derived from the signed mints. The snapshot authority therefore cannot invent issuance.
- v0.4.2 invariants still apply on restore: state and nullifier roots, nullifier seen-set, note openings and nonces, in-order transaction replay under the same rules as `submit()`, spent flags and per-account balances against unspent notes (plus treasury fee income). Snapshot **format version 3** is required; v1/v2 snapshots are rejected with `INVALID_SNAPSHOT_VERSION` and must be re-taken.
- Pending reconciliation never settles or applies a queued spend: invalid envelopes are rejected, valid ones stay queued (`LOCAL_VALID`, flagged on conflict) until applied through `submit()`.

**Residual trust model (testnet):** whoever holds the snapshot authority private keys controls what their node signs, and whoever holds the faucet key controls testnet issuance on that node. Signatures, the hash chain and checkpoints make tampering by anyone else detectable and keep the two roles separate; they do not make a key holder honest. This is the trust model of the local testnet, not production consensus.

### Marketplace and IoT/M2M

- **v0.4.3:** reservations cost something. Only identities with a **registered Ed25519 key** (`registerIdentity`) can reserve, and every reservation carries the buyer's signature (`signReservation`). The **deposit** (default 1% of gross, minimum 1 unit; `reservationDeposit` / `reservationDepositBps`) is **locked from the buyer's marketplace balance at `reserve()`**; without funds there is no reservation.
- When the order is funded, the deposit **counts toward the payment** (`fundOrder(orderId, order.fundingDue)`). An unfunded reservation that **expires** forfeits the deposit to the provider. A signed **buyer cancellation** within `cancellationGraceMs` (default 2 minutes) refunds it; after the window it goes to the provider. Provider or admin cancellation, and expiry of a funded but undelivered order, refund the buyer in full.
- Per-identity limit on concurrent open reservations (`maxActiveReservationsPerIdentity`, default 8) and a short TTL (`reservationTtlMs`, default 10 minutes); `expire()` is only possible after the TTL. `valueAccounting(asset)` checks conservation across every deposit path.
- IoT settlement requires an authenticated buyer or the configured settlement arbiter. Machine/provider deactivation requires an admin authorization callback. IoT `requestService()` requires the buyer's reservation signature, and `hold()` funds the remainder after the locked deposit, including any sponsored gas fee.

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

The public reference layer intentionally avoids requiring the large private development workspace or a production proving ceremony.

### Minimal reproducible verification

```bash
npm install
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

## 8. Public repository architecture

```text
.
├── README.md
├── LICENSE
├── NOTICE
├── SECURITY.md
├── CONTRIBUTING.md
├── PUBLIC-SCOPE.md
├── CHANGELOG.md
├── PUBLIC-SECURITY-REMEDIATION-v0.4.1.md
├── PUBLIC-SECURITY-REMEDIATION-v0.4.2.md
├── PUBLIC-SECURITY-REMEDIATION-v0.4.3.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── .gitignore
├── .gitattributes
├── .github/workflows/ci.yml  # CI: npm test + smoke test (Node 22.x / 24.x)
│
├── src/
│   ├── core/                 # Minimal public economic/cryptographic primitives
│   │   ├── field.ts
│   │   ├── hash.ts
│   │   ├── encoding.ts
│   │   ├── fee.ts
│   │   ├── note.ts
│   │   ├── nullifier.ts
│   │   ├── smt.ts
│   │   ├── transition.ts
│   │   ├── transaction.ts
│   │   ├── reconciliation.ts
│   │   ├── address.ts
│   │   ├── assets.ts
│   │   ├── security-policy.ts
│   │   ├── ed25519.ts        # Ed25519 helpers (node:crypto) for snapshots, mints, buyer signatures
│   │   ├── spend-proof.ts
│   │   ├── status.ts
│   │   ├── zk-witness-contract.ts
│   │   ├── index.ts
│   │   └── uep-smt-key-hardening.test.ts
│   │
│   ├── identity/             # Deterministic test identities
│   ├── network/              # Public TESTNET profile only
│   ├── testnet/              # Local UEP ledger reference implementation + tests
│   ├── marketplace/          # Marketplace business layer + tests
│   └── service/              # Content integrity + IoT/M2M service layer
│       ├── content-hash.ts
│       ├── iot-m2m.ts
│       ├── iot-m2m-codec.ts
│       ├── iot-m2m.test.ts
│       └── index.ts
│
├── examples/
│   └── first-transaction.ts
│
├── scripts/
│   ├── testnet-smoke.ts
│   └── marketplace-20k-simulation.mjs
│
└── docs/
    ├── ARCHITECTURE.md
    ├── THREAT-MODEL.md
    └── REPRODUCIBILITY.md
```

The structure is intentionally much smaller than the internal development workspace.

---

## 9. Transaction model

At the public reference layer, a testnet spend conceptually follows:

```text
Identity
   │
   ├── Account ID = H(secret, salt)
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
   └── state/nullifier roots change
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
DELIVERY
  │
  ▼
CONTENT / DELIVERY VALIDATION
  │
  ▼
SETTLEMENT
  │
  ├── provider payout
  └── 3% Marketplace fee → Marketplace Treasury
```

The design deliberately charges the Marketplace fee only at successful settlement. Failed, cancelled or expired orders do not become Marketplace fee income.

Since v0.4.3 the reservation step is signed and funded: a registered buyer signs the reservation, the reservation deposit is locked from the buyer's balance, and funding pays the remainder (`grossAmount + gasFee − deposit`). The deposit is refunded on a buyer cancellation within the grace window and on provider/admin cancellation; it goes to the provider when an unfunded reservation expires or the buyer cancels after the grace window. A funded order that expires undelivered is refunded in full.

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

The internal project contains additional ZK research and implementation work, but the following are intentionally **not published here as production guarantees**:

- production proving keys;
- production verification keys;
- ceremony secrets;
- private proving infrastructure;
- internal ZK worker deployment configuration;
- confidential audit material.

If a future public release reaches a production-cryptographic milestone, it should be published as a separately reviewed and versioned cryptographic release rather than silently upgrading the claims of this repository.

---

## 13. Multi-node and interplanetary status

The internal UEP project investigates multi-node consensus, delayed networking, DTN-style transport and interplanetary reconciliation.

Those areas are **research tracks**, not features that this repository claims to provide as a live network.

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
- experimental consensus branches not required for the public reference testnet;
- private deployment tooling;
- unrelated application code.

See [`PUBLIC-SCOPE.md`](./PUBLIC-SCOPE.md) for the explicit publication boundary.

---

## 15. How to contribute

Security findings, reproducibility problems, implementation bugs and protocol questions are welcome.

Please read:

- [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- [`SECURITY.md`](./SECURITY.md)

Do not publish private keys, credentials, personal data, customer information or undisclosed exploit material in an issue or pull request.

---

## 16. Research transparency

UEP is deliberately developed using an adversarial engineering process:

```text
DESIGN → IMPLEMENT → TEST → ATTACK → MEASURE → CORRECT → DOCUMENT
```

A public release therefore documents limitations even when doing so makes the project look less mature. That is intentional: the objective is for independent developers to understand **what is real, what is simulated, and what remains an open research problem**.

---

## 17. Roadmap boundary for this repository

This repository is a foundation for public experimentation, not the entire UEP roadmap.

Future work may include, subject to independent verification:

- stronger public testnet execution;
- reproducible multi-node deployments;
- formally specified consensus/finality components;
- production-grade ZK proving and verification;
- public network APIs;
- external service-provider adapters;
- delayed-network/DTN experiments;
- cross-domain settlement research;
- additional real-world asset/resource attestations.

A future feature should not be considered part of the public protocol merely because it exists in an internal branch or research document.

---

## 18. Test wallet seeds and BIP-39

All BIP-39 recovery phrases used by the public examples and tests are generated at runtime with the platform cryptographic random generator. No fixed mnemonic, private key, seed phrase or personal wallet credential is embedded in this repository. Test identities are disposable testnet identities and must never be funded with real-world value.

This repository audit found no hard-coded BIP-39 mnemonic or personal wallet seed. Historical use outside the repository cannot be established from source code alone; the project therefore makes no claim about any seed that may have existed in an earlier private environment.

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
