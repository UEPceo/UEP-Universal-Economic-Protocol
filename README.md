# Universal Economic Protocol (UEP)
## Public Testnet Reference + Digital Marketplace

> **Public evaluation release — October 2026**  
> **Version:** `0.3.1-public-preview`

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
- adversarial tests for replay, double spending, ownership and transaction mutation.

The transaction path is intentionally explicit about its security boundary: **the public testnet uses the development/reference spend-MAC path, not a production SNARK ceremony**.

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

## 4. Important status: what this repository is NOT

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

## 5. Reproducibility

### Requirements

- Node.js **22.6 or newer**
- Git

The public reference layer intentionally avoids requiring the large private development workspace or a production proving ceremony.

### Run all public tests

```bash
npm test
```

### Run only the protocol/testnet tests

```bash
npm run test:protocol
```

### Run only Marketplace tests

```bash
npm run test:marketplace
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

## 6. Public repository architecture

```text
.
├── README.md
├── LICENSE
├── NOTICE
├── SECURITY.md
├── CONTRIBUTING.md
├── PUBLIC-SCOPE.md
├── CHANGELOG.md
├── package.json
├── tsconfig.json
├── .gitignore
├── .gitattributes
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
│   │   └── spend-proof.ts
│   │
│   ├── identity/             # Deterministic test identities
│   ├── network/              # Public TESTNET profile only
│   ├── testnet/              # Local UEP ledger reference implementation
│   ├── marketplace/          # Marketplace business layer + tests
│   └── service/              # Delivery/content integrity primitive
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

## 7. Transaction model

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

## 8. Marketplace lifecycle

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

---

## 9. Security philosophy

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

## 10. ZK status

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

## 11. Multi-node and interplanetary status

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

## 12. What has deliberately been removed from the public release

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

## 13. How to contribute

Security findings, reproducibility problems, implementation bugs and protocol questions are welcome.

Please read:

- [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- [`SECURITY.md`](./SECURITY.md)

Do not publish private keys, credentials, personal data, customer information or undisclosed exploit material in an issue or pull request.

---

## 14. Research transparency

UEP is deliberately developed using an adversarial engineering process:

```text
DESIGN → IMPLEMENT → TEST → ATTACK → MEASURE → CORRECT → DOCUMENT
```

A public release therefore documents limitations even when doing so makes the project look less mature. That is intentional: the objective is for independent developers to understand **what is real, what is simulated, and what remains an open research problem**.

---

## 15. Roadmap boundary for this repository

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

## 15.5. Test wallet seeds and BIP-39

All BIP-39 recovery phrases used by the public examples and tests are generated at runtime with the platform cryptographic random generator. No fixed mnemonic, private key, seed phrase or personal wallet credential is embedded in this repository. Test identities are disposable testnet identities and must never be funded with real-world value.

This repository audit found no hard-coded BIP-39 mnemonic or personal wallet seed. Historical use outside the repository cannot be established from source code alone; the project therefore makes no claim about any seed that may have existed in an earlier private environment.

## 16. License and acceptable use

This repository is released under the **Apache License 2.0 (Apache-2.0)**. It is a permissive open-source license that permits use, modification, distribution and commercial use subject to its terms. The repository remains a testnet/reference implementation: publication under Apache-2.0 does not imply that UEP is production-ready, that testnet assets have real-world value, or that any separate UEP trademark, service, production credential or unpublished project material is licensed.

Read the complete terms in [`LICENSE`](./LICENSE) before using the code.

---

## 17. Disclaimer

This software is experimental. It is provided for research, evaluation and testing purposes. No representation is made that the implementation is secure, fault tolerant, economically viable, legally compliant in every jurisdiction, or suitable for production use.

Nothing in this repository constitutes an offer, solicitation, investment product, payment service, financial advice, custody service or guarantee of value.

---

## 18. Project principle

UEP is being developed around a simple principle:

> **Build useful economic infrastructure first; introduce complexity only when a demonstrated technical or economic need justifies it.**

That principle is why this public release contains a reproducible testnet and a real-service Marketplace model, while deliberately avoiding a speculative native token and avoiding claims that the current research stack is already a finished global or interplanetary financial network.


Project contact: contact@uep-project.org
