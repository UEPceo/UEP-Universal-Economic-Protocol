# UEP Roadmap

This is the public roadmap of the Universal Economic Protocol (UEP). It describes where the project is today, the phases ahead, and what each phase has to deliver before the next one starts.

> **Goals, not commitments.** The phases and the year buckets below are planning goals. They are not delivery dates, promises or financial commitments. A phase starts only when the previous one meets its exit criteria and an independent assessment confirms it.

For the layer-by-layer architecture and the current status of each layer, see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Principles that do not change

- **No native token.** UEP does not need a native token today. One would only be considered if a real technical or economic need is demonstrated.
- **Utility fees, not issuance.** The testnet protocol fee is **0.1%** (minimum 1 unit) and the Marketplace fee is **3%** of settled service value (minimum 1 unit, charged only on successful settlement). Infrastructure should be funded by real economic activity.
- **Testnet only.** Nothing in this repository is a production network. Testnet balances have no real-world value.
- **Honest status.** A passing test is evidence of one tested property, not proof that the protocol is secure. External reviews are independent assessments; they do not make the code "secure" or "production-ready".
- **Donations are donations.** The voluntary BTC donation address in the README is a gift to support research. It is not an investment, pre-sale or token allocation.

## Where we are (October 2026)

| Item | Status |
|---|---|
| Current version | `0.5.3-public-iot-m2m` on branch `v0.5.3-fixes` (not released): asset registry wired into the ledger, settlement anchors, multi-input transactions, oracle gate, category fixes; on top of `0.5.2-public-iot-m2m` on `main` (not released: settlement engine, category modules hashlock swap/relay/dispute/drip, oracle policy layer) and `0.5.1`. Latest GitHub Release: `v0.5.0` |
| Tests | testnet: protocol 144/144, Marketplace + IoT/M2M + HTTP + attack-battery 176/176, settlement 5/5, oracle 7/7, category 4/4; poisoned clock 298; research labs: Rust 115, labs 463 in 98 files (`npm run test:all` runs everything) |
| Simulation | `npm run simulate:20k`: 20,000 signed, funded settlements, 0 errors, value conserved (in-process, not a throughput claim) |
| CI | GitHub Actions: `npm run test:all` on Node.js 22.x and 24.x (blocking); 14 lab files with known issues in a separate non-blocking job |
| Network | Local, single-node, in-process testnet |
| Research labs | Rust/ZK core in `uep-core/`, consensus, node, economic and agent experiments in `src/lab/` and `src/agent/`: experimental, not part of the testnet ([`docs/LABS.md`](./docs/LABS.md)) |

```text
Phase 0  Foundation                      done
Phase 1  Hardened public testnet         closing          ← we are here
         Multi-asset                     ADR 0001 + signed registry manifest (v0.5.0); ledger wiring next
Phase 2  Service economy                 in progress      ← and here
Phase 3  Public developer platform       planned
Phase 4  Multi-node testnet              planned
Phase 5  Public testnet                  planned
Phase 6  Economic network                future
Phase 7  Production protocol             future
Phase 8  Autonomous economic infra       future
Phase 9  Interplanetary economic network research
```

---

## Phase 0 — Foundation · Done

**Goal:** a working reference of the economic core and the first service application.

**Delivered (v0.3.x – v0.4.0):** architecture; core primitives (transactions, notes, commitments, nullifiers, state roots, fees); local ledger; Marketplace foundation (listings, orders, HOLD, delivery, settlement, treasury); IoT/M2M prototype.

---

## Phase 1 — Hardened public testnet · Closing

**Goal:** anyone can run UEP and check that the economic system works without depending on the team.

**Delivered (v0.4.1 – v0.5.2):**

- Ledger: 254-bit SMT keys, input notes resolved against the ledger, output and nonce binding, distinct transfer participants, restore that re-derives the full state.
- Snapshots: Ed25519 authorities with optional k-of-n threshold, hash chain and checkpoints, a separate faucet key with signed mints, verify-only restore with public keys.
- Spends: Ed25519 sender signatures, a validated and bounded pending queue, an append-only note-commitment Merkle tree with membership proofs, a 1-unit fee floor.
- Accounts: key-derived account ids and checksummed Bech32m v2 addresses (`uep1…`).
- Marketplace: signed actions, party-only order access, reservation deposit locked at `reserve()`, disputes with arbiter resolution and a guarded timeout, capacity returned exactly once.
- IoT/M2M: machine keys required, signed telemetry with sequence and nonce anti-replay, settlement only against verified telemetry for the full quantity.
- Per-asset hardening (v0.4.7): canonical asset ids, per-asset balance keying in the Marketplace, per-asset issuer keys with rotation and revocation, restore rejects unregistered assets, per-asset policy limits and fee floors, atomic multi-note payments, `requireProof` fixed at construction.
- v0.5.0: API authorization hardening (signed actor headers, fail-closed 401/403, signed treasury read, objects token, CORS off by default), ledger spends authorized by the sender signature by default, paymaster caps and expiry, a compressed sparse Merkle tree, a duplicate-listing index, circuit v4 keyed by (account, asset) with pinned development verifying keys, namespaced asset ids and the signed asset registry manifest module.
- v0.5.1: deterministic height-based transitions (ADR 0002), monotonic height producer, domain delay windows (EARTH/MOON/MARS), evidence value caps, snapshot format 7 with migrations, v3 account ids, object-route Host/Origin checks, lab domain binding, 130-bit self-certifying namespaces.
- v0.5.2: settlement engine as the single payout path behind Marketplace and category HOLDs; category modules (hashlock swap, relay, dispute, drip) over Marketplace escrow/subsidy ports; oracle layer with repository Poseidon BN254 for policy evaluation only (not on the spend path); attack-battery hardenings (concurrent spend guard / `SpendSerializer`, unfunded reservation caps, `ORDER_STATE_CONFLICT`, paymaster capture on settle, relay custody 20 % / delivery 80 %). Deferred: IoT hardware attestation, HPKE for relay payloads.
- v0.5.3 (branch, not released): asset registry wired into the ledger (snapshot format 8), settlement receipts bound to the network and anchored in ledger state with RFC 9162 consistency proofs, multi-input transactions (ADR 0004), oracle hardening and `OraclePolicyGate`, relay/dispute fixes, published crypto test vectors, blocking lab CI job.
- Independent adversarial assessments with published per-finding status up to v0.4.6 (`PUBLIC-SECURITY-REMEDIATION-v0.4.x.md`). Later versions: non-public reports or internal review only, see [`docs/SECURITY-COVERAGE.md`](./docs/SECURITY-COVERAGE.md) and [`docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md`](./docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md).

**Still open (documented in [`PUBLIC-SECURITY-REMEDIATION-v0.4.6.md`](./PUBLIC-SECURITY-REMEDIATION-v0.4.6.md)):**

- UEP-A11 / A12: the development spend MAC. Mitigated, because the Ed25519 sender signature is always required; since v0.4.7 `requireProof` is fixed at construction and cannot be turned off outside tests.
- UEP-A22: range checks in the ZK witness (needed before production ZK).
- UEP-C04: one input note per transaction (deliberate for now). Since v0.4.7 a payment can use several notes as an atomic batch of single-input spends.
- Trust assumptions: the settlement arbiter, operator-attached category hooks, and machine keys (signed telemetry is not physical proof).

**Next milestone — close Phase 1:**

- *Deliverables:* `requireProof` cannot be disabled outside tests (done in v0.4.7); a written plan to retire the development MAC; public architecture and roadmap documents (this file); a from-scratch reproduction guide.
- *Exit criteria:* CI green on Node.js 22 and 24; an independent assessment with no new critical or high-severity findings; a third party reproduces `npm run test:all` (which includes `npm test` and `npm run simulate:20k`) from a clean clone using only the documentation.

---

## Multi-asset · In progress

The ledger already keeps balances per account and asset and commits the asset id into notes and transactions. Turning that into a guaranteed multi-asset property is a separate milestone.

**Status:** in progress. An exit-criteria assessment returned **NO-GO**. v0.4.7 delivers the engineering hardening that needs no design decision (per-asset isolation, issuance scope, policy limits and fee floors, multi-asset tests). v0.5.0 records the unit and asset model decisions (D-1, D-3) in [`docs/adr/0001-asset-model.md`](./docs/adr/0001-asset-model.md) and ships namespaced asset ids plus the governance-signed registry manifest with threshold issuer key sets. Next: wire the manifest into the ledger (snapshot format 7, threshold-signed mints, no faucet fallback). The other blockers still need written design decisions (scope, fees, arbitration, ZK, consensus, Sybil resistance). Multi-asset will not convert between assets and will not introduce a native token.

---

## Phase 2 — Service economy · In progress

**Goal:** UEP runs reproducible economic services on the testnet, and applications no longer need to import internal classes.

**Partial progress in v0.5.2 (testnet):** the settlement engine, category modules (hashlock swap/relay/dispute/drip) and the policy-only oracle layer land ahead of milestones 2.3–2.4. They do not replace the event bus, storage abstraction, evidence system or generic service schemas still listed below.

```text
Provider → Service → Discovery → Request → Order → HOLD
        → Execution → Evidence → Verification → Settlement
```

| # | Milestone | Goal | Deliverables | Exit criteria |
|---|---|---|---|---|
| 2.1 | Event bus | Every observable transition emits an event | Versioned event catalogue (service, order, hold, delivery, verification, settlement, refund, dispute, capacity, machine, snapshot events); in-process emitter with ids for ordering and de-duplication | Each order and IoT transition emits exactly one event; replays are idempotent |
| 2.2 | Storage abstraction | Separate economic state, operational state and large data | Storage interface (memory and disk); signed Marketplace snapshot/restore | Marketplace restore re-checks value and capacity accounting |
| 2.3 | Evidence system | Evidence by hash and reference | Evidence records (hash, type, external reference, signer) for deliveries and telemetry, within the trust model and value caps already in place (`docs/EVIDENCE.md`); attester selection and payment; rules for locks across a solar conjunction | No settlement without evidence bound to the order; large data stays outside the state; adapters to external sources stay outside the state machine (ADR 0002) |
| 2.4 | Service execution interface | Generic execution per category | Service contract with input/output schemas, requirements and SLA; documented category hooks | A new category can be added without changing the Marketplace |
| 2.5 | Service plane registries | Typed identities with lifecycle | Identity types (human, machine, service, provider, node) and states (active, suspended, revoked); unified provider, machine and service registries | A suspended or revoked identity cannot sign new actions (negative tests) |
| 2.6 | Local API | Use UEP without importing internals | Local HTTP/JSON API over the service plane, authenticated by signatures | A full buyer–provider flow runs through the API only |
| 2.7 | IoT gateway | Connect real or simulated machines | Gateway with schema validation, retry and backoff, offline queues, idempotency | A simulated machine with network drops settles with no duplicates and no loss |
| 2.8 | SDK | Build without knowing the internals | TypeScript packages `@uep/client`, `@uep/marketplace`, `@uep/iot-m2m` | README examples rewritten with the SDK and green in CI |
| 2.9 | Developer sandbox | One-command local environment | Local node, Marketplace, IoT service and sample data | A newcomer completes an order end to end from the docs alone |
| 2.10 | Simulators | Realistic load and behaviour | Service-provider and machine simulators, including failures and adversaries | Reproducible scenarios with value and capacity conserved |

---

## Phase 3 — Public developer platform

**Goal:** third parties can build on UEP.

```text
Developer → SDK → API → Service registry → Marketplace → UEP
```

- *Deliverables:* documentation, SDK, examples, CLI, local node, sandbox, API, authentication, service templates, IoT simulator.
- *Exit criteria:* versioned API and SDK with a compatibility policy; at least one example service built outside the core team; an independent assessment of the API surface.

---

## Phase 4 — Multi-node testnet

**Goal:** several nodes keep the same state under failures and Byzantine behaviour. This is where the security level changes substantially.

```text
Node A
Node B
Node C
Node D
   │
   └── consensus
```

- *Starting point:* the local consensus experiments in `src/lab/` (leader election, quorum and commit certificates, BFT configuration gate, DAG dissemination, partitions, view change; see [`docs/LABS.md`](./docs/LABS.md)). They are research inputs, not the deliverable, and several of them have known failures (`scripts/lab-known-issues.json`).
- *Prerequisites:* validity rules that do not depend on local configuration; key rotation and revocation; a written consensus scope.
- *To test:* state replication, conflicting transactions, leader failure, view change, network partitions, snapshot exchange, recovery, Byzantine behaviour, cross-node replay, duplicate settlement, censorship until expiry, clock drift.
- *Exit criteria:* a reproducible multi-node test harness in CI; nodes with different local configurations accept exactly the same transactions; an independent assessment of consensus.

---

## Phase 5 — Public testnet

**Goal:** open UEP to developers, researchers and early providers.

- *Deliverables:* onboarding, public nodes, explorers, service registry, Marketplace, IoT/M2M sandbox, monitoring, faucet and test assets, documentation, bug bounty and assessment process.
- *Exit criteria:* stable operation over a defined period; a tested incident process; no open critical or high-severity findings.

---

## Phase 6 — Economic network

**Goal:** once the testnet is stable, users, apps, agents, providers, machines, nodes, oracles, relayers and storage start to form a service economy.

- Infrastructure is funded by real activity and utility fees, not by premature speculative issuance.
- *Deliverables:* provider and node economics; treasury governance; sustainable dispute mechanisms.

---

## Phase 7 — Production protocol

Before any production use:

- **Security:** several independent assessments, fuzzing, formal verification where useful, cryptographic review, consensus review, dependency review.
- **Infrastructure:** high availability, monitoring, backups, disaster recovery, key management, incident response.
- **Economics:** fee model, treasury governance, dispute mechanisms, provider and node economics.
- **Legal and compliance:** specific review for each jurisdiction and service offered.

---

## Phase 8 — Autonomous economic infrastructure

```text
Human → Application → Agent → Machine → Service → Economic protocol → Infrastructure
```

An agent, or a machine on its own, could discover a service, compare terms, contract it, fund it, check it, receive the result and settle it. This needs agent identities with spending limits and revocation.

---

## Phase 9 — Interplanetary economic network (research)

```text
                 EARTH
                   │
           ┌───────┴───────┐
           │               │
         MOON           LAGRANGE
           │               │
           └───────┬───────┘
                   │
                 MARS
                   │
              DEEP SPACE
```

Delay-tolerant networking, asynchronous settlement, delayed consensus, local economic domains, cross-domain receipts, autonomous agents and machine economies. The target property: **the economy keeps working even when communication between participants has extreme latency or long interruptions.** Nothing here is an operational claim today.

---

## Summary by year (goals, not commitments)

```text
2026
├── Foundation                      done
├── Hardened testnet                v0.4.0 – v0.5.0, independent assessments, closing
├── Service economy                 registries, lifecycle (done); events, storage, API, IoT gateway
└── Developer platform              SDK, sandbox, simulators

2027+
├── Multi-node
├── Public testnet
├── Distributed services
├── Provider economy
├── Node economy
└── Autonomous agents

2028+
├── Production network
├── Cross-domain economy
├── Advanced ZK
└── Interplanetary infrastructure (research)

Future
└── Autonomous / interplanetary economic network
```

## How to help

The best places to contribute right now are Phase 2 (event bus, storage, API, SDK, simulators), more negative and property-based tests, and reproducibility reports. See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Report vulnerabilities privately as described in [`SECURITY.md`](./SECURITY.md).
