# Public Architecture

This document describes the UEP architecture as fourteen layers (A–N), what of each layer exists in this repository today, and how the implemented parts fit together. The phases that complete each layer are in [`ROADMAP.md`](../ROADMAP.md).

Everything described as implemented runs on the **local, single-node, in-process testnet**. Nothing here is a production network, and there is no native UEP token.

Per-module status, version, tests and documentation (including settlement, categories and the oracle): [`MODULES.md`](./MODULES.md).

## 1. Global view

UEP is not simply a blockchain, a cryptocurrency or a marketplace. The goal is an economic protocol where people, companies, applications, agents and machines can offer, discover, contract, execute, verify and settle economic services, with the economy and the infrastructure growing together.

```text
                          UEP
          UNIVERSAL ECONOMIC PROTOCOL
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
       ▼                 ▼                 ▼
   PROTOCOL          ECONOMIC           SERVICES
    LAYER              LAYER               LAYER
       │                 │                 │
       │                 │          ┌──────┴──────┐
       │                 │          │             │
       │                 │      Marketplace    IoT/M2M
       │                 │
       └────────────┬────┘
                    │
              UEP ECONOMIC STATE
                    │
          ┌─────────┼─────────┐
          │         │         │
        Notes    Nullifiers  Roots
          │         │         │
          └─────────┼─────────┘
                    │
             Verification
                    │
              Settlement
                    │
                 Treasury
```

## 2. Layer status

| Status | Meaning |
|---|---|
| **Implemented (testnet)** | In this repository, with tests, on the local single-node testnet |
| **Partial** | Part of the layer is in code; important pieces of the design are missing |
| **Design** | Defined in architecture documents; no code in this repository |
| **Future** | A later phase; neither code nor a settled design |

Research labs (`src/lab`, `src/agent`, the service/API lab in `src/service`, `uep-core/`) are mentioned in the table as **Labs** where they explore a layer. They are experimental, are not part of the testnet rules and never count toward a layer's status ([`LABS.md`](./LABS.md)).

| Layer | Status | In this repository today | Main gaps |
|---|---|---|---|
| **A. Core protocol** | Implemented (testnet) | `src/core`: transactions and TxIDs, nonces, notes, commitments, nullifiers, state roots, state transition, 0.1% fee with a 1-unit floor, value conservation | Multi-input spends (nullifier vector) |
| **B. Economic state / ledger** | Implemented (testnet) | `src/testnet/ledger.ts`: 254-bit SMT, note-commitment Merkle tree, Ed25519 k-of-n hash-chained snapshots, signed mints, validated pending queue; per-asset hardening (v0.4.7): canonical asset ids, per-asset issuer keys, per-asset policy limits and fee floors, atomic multi-note payments; spends authorized by the sender signature, compressed SMT storage, namespaced asset ids (v0.5.0) | True multi-input spends (nullifier vector); wiring the signed asset registry manifest into the ledger (ADR 0001) |
| **C. Cryptography / ZK** | Partial | Poseidon BN254 protocol hash (`src/core/poseidon.ts`, the same hash as the spend circuit; snapshot format 7, format 6 migrated, see [`COMPATIBILITY.md`](./COMPATIBILITY.md)), Ed25519 via `node:crypto`, SMT, note tree, ZK witness contract (not wired), development spend MAC. Labs: the UEP-26 Groth16 spend circuit (`uep-core/`, `src/lab/`, experimental, see [`LABS.md`](./LABS.md)) | Production circuits, a 254-level circuit tree and in-circuit key-derived account ids (see [`LABS.md`](./LABS.md)), witness range checks (UEP-A22), production keys and ceremony |
| **D. Consensus & network** | Future | A `local://` testnet profile only. Labs: local multi-process consensus experiments in `src/lab/` (experimental) | Replication, consensus, P2P |
| **E. Marketplace** | Implemented (testnet) | `src/marketplace` plus `src/settlement` / `src/category` / `src/oracle` (v0.5.2): listings, funded reservations, HOLD, delivery, disputes with an arbiter, settlement through the single settlement engine, treasury, paymaster (capture on settle), reputation; category modules swap/relay/dispute/drip over escrow ports; policy-only oracle (Poseidon BN254); balances indexed per asset and identity; unfunded reservation caps, `ORDER_STATE_CONFLICT`, relay 20/80 custody split; paymaster caps and expiry, duplicate-listing index (v0.5.0) | Re-attaching category hooks and ports after a restore (Marketplace state itself is in snapshot format 4); service schemas and SLA; a real payment rail; IoT hardware attestation; HPKE for relay payloads |
| **F. Service plane** | Partial | Signed identities, IoT provider and machine registries, listings as the service registry, `attachCategoryService()` | A decoupled layer with typed registries and identity states; a generic execution interface |
| **G. IoT / M2M** | Implemented (testnet) | `src/service/iot-m2m*.ts`: machine Ed25519 keys, signed canonical-CBOR telemetry, anti-replay, settlement against verified telemetry | Gateway, retry/backoff, machine offline mode, schema validation, physical attestation |
| **H. Identity & authorization** | Partial | Key-derived accounts, `uep1` Bech32m addresses, a signed `ActorAuth` on every action, admin and arbiter keys, per-asset issuer key rotation and revocation (v0.4.7); signed actor headers and fail-closed HTTP/service API (v0.5.0) | Rotation of snapshot, admin and arbiter keys; suspended/revoked states, Sybil resistance |
| **I. Events / storage / API** | Design | Content hashes as delivery evidence; all state is in memory. Lab: a versioned service API and storage abstraction in `src/service/` (experimental) | Event bus, storage abstraction, network API |
| **J. SDK / developer platform** | Design | TypeScript library API ([`API.md`](./API.md)), the first-transaction example, test kits | `@uep/*` packages, CLI, sandbox |
| **K. Node / infrastructure** | Future | Role separation inside one node: snapshot authority, faucet key, verify-only node. Labs: node protocol, TCP transport and handshake in `src/lab/` (experimental). The v0.5.2 policy oracle in `src/oracle` is Implemented (testnet) under Marketplace, not a network oracle role | Node processes, validators, provers, network oracles, relayers |
| **L. Testnet** | Implemented (testnet), local only | In-process ledger, smoke test, quickstart, 20k simulation, CI on Node.js 22 and 24 | Local multi-node, public testnet |
| **M. Interplanetary extensions** | Future | Labels only: non-public `GLOBAL` / `INTERPLANETARY` profiles and simulated assets | Delay-tolerant networking, asynchronous settlement |
| **N. Public economic network** | Design | 0.1% protocol fee and 3% Marketplace fee with the 40/25/20/15 treasury split, on testnet | Provider and node economics, treasury governance |

## 3. Layering of the implemented code

```text
┌──────────────────────────────────────────────┐
│        IoT/M2M SERVICE (src/service)         │
│ machines · signed telemetry · verification   │
└───────────────────────┬──────────────────────┘
                        │ attachCategoryService()
                        ▼
┌──────────────────────────────────────────────┐
│  CATEGORIES / ORACLE (src/category, oracle)  │
│ swap · relay · dispute · drip · policy quotes│
└───────────────────────┬──────────────────────┘
                        │ escrow / subsidy ports
                        ▼
┌──────────────────────────────────────────────┐
│           UEP DIGITAL MARKETPLACE            │
│ listings · orders · HOLD · delivery · fees   │
│ disputes · treasury · reputation · paymaster │
└───────────────────────┬──────────────────────┘
                        │ SettlementEngine.payout
                        ▼
┌──────────────────────────────────────────────┐
│          SETTLEMENT (src/settlement)         │
│ single payout executor · receipt Merkle tree │
└───────────────────────┬──────────────────────┘
                        │
                        │ business-layer boundary
                        ▼
┌──────────────────────────────────────────────┐
│                 UEP TESTNET                  │
│ identities · notes · transactions · SMT      │
│ nullifiers · fees · local state transition   │
│ concurrent spend guard / SpendSerializer     │
└──────────────────────────────────────────────┘
```

### Why the layers are separate

The Marketplace is a business application. UEP core is an economic state-transition
reference implementation. Keeping the boundary explicit prevents the public release
from implying that a marketplace order automatically becomes a consensus-finalized
protocol transaction. Marketplace balances are business-layer accounting.

**Settlement anchors (v0.5.3).** Settled orders and category holds are anchored into the
ledger (consensus) state: `marketplace.anchorSettlements(ledger)` hands the new settlement
receipts to `UepLedger.anchorSettlements()`, which re-checks every receipt (hash,
escrow conservation, treasury binding, no settlement anchored twice), computes the RFC 9162
batch root and per-asset totals, appends a hash-chained anchor at the current height, commits
it in the signed snapshot (format 8) and re-checks the chain on restore. A holder of a receipt
can prove inclusion against the anchored root (`verifyReceiptInclusion`). What remains outside
consensus: the anchor does not move ledger value (Marketplace balances are not ledger notes),
and the ledger does not re-execute Marketplace authorization or dispute rules. See
[`SETTLEMENT-BRIDGE.md`](./SETTLEMENT-BRIDGE.md).

## 4. Layer details

### A. Core protocol — Implemented (testnet)

Transactions, transaction ids, nonces, notes, commitments, nullifiers, state and nullifier roots, state transitions, fee accounting, verification and value conservation (`inputs = outputs + fees`).

- Outputs are bound to the transaction: output 0 pays exactly `amount` to the recipient, the optional output 1 returns `input − amount − fee` to the sender (v0.4.2).
- The transaction nonce is the consumed note's nonce, so the nullifier is anchored to that note (v0.4.2).
- Sender, recipient and treasury must be distinct accounts. Self-transfers are rejected.
- Fee: `max(1, floor(amount × 10 / 10,000))`, i.e. 0.1% with a 1-unit floor (v0.4.4).

### B. Economic state / ledger — Implemented (testnet)

```text
                Ledger
                │
       ┌────────┼────────┐
       │        │        │
     Notes   Nullifiers  Roots
       │        │        │
       └────────┼────────┘
                │
          State transition
                │
         old_root → new_root
```

The testnet maintains:

- balances keyed by account + asset;
- note commitments, in an append-only note-commitment Merkle tree (depth 32) whose root and size are part of snapshots; spends carry a membership proof;
- key-derived account ids (v0.4.5, UEP-ADDR-002): every note owner commits to an Ed25519 spend key, and every spend reveals the key and signs it (no key registry); addresses are Bech32m v2 strings (version, network tag, key hash);
- a Sparse Merkle representation of account/asset state (254-bit keys);
- a nullifier set;
- accepted transactions;
- pending/conflicting transactions (validated at entry and on restore, bounded by `maxPendingTransactions`);
- deterministic snapshots, signed by Ed25519 snapshot authorities (optional k-of-n), hash-chained (`prevSnapshotHash`), with faucet mints signed by a separate faucet key.

`restore()` re-derives the whole state (roots, note tree, balances, supply from signed mints, treasury fees, pending queue) and rejects anything `faucet()` and `submit()` could not have produced. A ledger restored with public keys only is verify-only.

Since v0.4.7 every asset is isolated: asset ids follow a canonical grammar (since v0.5.0 `<namespace>/<symbol>`, see [`adr/0001-asset-model.md`](./adr/0001-asset-model.md)), notes of another asset are rejected (`ASSET_MISMATCH`), each asset can have its own issuer key (rotation and revocation in snapshot trust), `restore()` rejects unregistered assets, and policy limits and fee floors are per asset.

Multi-input (UEP-C04, v0.5.3, ADR 0004): a transaction may consume 1 to 8 notes with a nonce / nullifier vector, one protocol fee per transaction and one change note; single-input transactions keep the v0.5.2 form. Self-consolidation (sender = recipient) is still refused, and the ZK circuits prove one nullifier. The unit and asset model are decided in ADR 0001; the signed registry manifest exists as a module (`src/core/asset-registry.ts`) and its ledger integration is the next milestone (see the roadmap).

### C. Cryptography / ZK — Partial

```text
CRYPTOGRAPHIC FOUNDATION
        │
        ├── Implemented (testnet): Poseidon BN254 protocol hash, Ed25519,
        │                          SMT, note tree, commitments, nullifiers
        │
        ├── Testnet: development spend MAC + mandatory Ed25519 sender signature
        │
        └── Production ZK: separate milestone, not in this repository
```

The public release uses deterministic field/hash/commitment primitives and the
reference development spend-MAC path, plus Ed25519 (`node:crypto`) signatures for
sender spend keys, snapshots, mints, Marketplace actions and IoT telemetry. The active hash is Poseidon over BN254 (x^5, t = 3, circomlib-compatible constants), checked against the `uep-core/vectors` test vectors; the older SHA-256-to-field backend is kept only as an inactive reference. The ZK witness contract is not wired into the transaction path and has no range checks yet (UEP-A22). The repository deliberately does not claim a production Groth16/Nova deployment. A development circuit is never treated as production ZK.

Labs: the UEP-26 Groth16 spend circuit (v4, `UEP-27-SPEND-POSEIDON-D32-v4-assetkey`, state slots keyed by (account, asset), pinned development verifying keys) and the `uep-zk` CLI in `uep-core/uep-26-spend-circuit`, the Poseidon R1CS gadget in `uep-core/uep-21-poseidon`, and the TypeScript bridge in `src/lab/zk-*.ts`. They use development keys from a seeded setup (no ceremony), a 32-level tree and the older `H_ACCOUNT(secret, salt)` account binding, so they are not interchangeable with the testnet path (see [`LABS.md`](./LABS.md), "Differences between the labs and the public core").

### D. Consensus & network — Future

```text
Users → Apps / Agents → Nodes → Validators / Provers → Relayers → Oracles → Storage
```

The testnet has one `local://uep-testnet-1` profile, and its code path has no consensus or P2P networking. Signed, hash-chained snapshots and verify-only restore are the groundwork for replication. Planned evolution: local testnet → multi-node testnet → distributed testnet → public testnet → production network.

Labs: `src/lab/uep34-*` to `uep38-*` contain local consensus experiments (leader election and heartbeat, quorum and commit certificates, a classic BFT configuration gate with `N = 3f + 1`, DAG dissemination, partitions and recovery, multi-leader aggregates, single-proposer schedule, silent-leader view change, an SMT economic state on the consensus path). They run in-process or as local processes over TCP on one machine. Several of these suites have known failures and run in a non-blocking CI job (`scripts/lab-known-issues.json`). They are research inputs to Phase 4, not a consensus implementation of the testnet.

### E. Marketplace — Implemented (testnet)

```text
Provider → Listing → Discovery → Reserve (signed + deposit) → Order (ACCEPTED)
   → HOLD (HELD, buyer-signed escrow) → Execution → Delivery (DELIVERED, signed hash)
   → Verification (hash; IoT: verified telemetry) → Settlement (SETTLED)

Alternative paths: CANCELLED · EXPIRED · DISPUTED → RELEASE | REFUND_BUYER (REFUNDED) | SPLIT
```

- Listings carry provider, category (`COMPUTE`, `STORAGE`, `API`, `DATA`, `IOT_M2M`), asset, unit price and capacity. Input/output schemas, requirements and SLA are design items.
- Reservations lock a deposit at `reserve()` (default 1%, minimum 1 unit), have a TTL and a per-identity limit.
- Disputes: the buyer opens within a window; the arbiter resolves; the provider can concede; an unresolved dispute times out (default refund). A `RELEASE` timeout runs the category guard (v0.4.6).
- Capacity returns to the listing exactly once when an order closes; `capacityAccounting()` checks it (v0.4.6).
- Fee: 3% of settled value (minimum 1 unit), only on settlement.

### F. Service plane — Partial

```text
                    Service Plane
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
   Identity          Registries          Requests
       │                  │                  │
       │       ┌──────────┼──────────┐       │
       │       │          │          │       │
       │   Provider    Machine    Service    │
       │                                     │
       └──────────────────┬──────────────────┘
                          │
                     Marketplace
                          │
                        Ledger
```

The goal is that services do not depend on the ledger's internal classes. Today the pieces live inside the Marketplace and the IoT service: identities registered with an Ed25519 key (self-service, first come, immutable), IoT provider and machine registries (with an `active` flag and signed deactivation), listings with `searchListings()`, and `attachCategoryService()` for category guards and evidence hooks. Typed identities (human, machine, service, provider, node) with active/suspended/revoked states are a design item.

### G. IoT / M2M — Implemented (testnet)

```text
Machine → Machine identity (Ed25519) → Service discovery → Service request (signed)
   → Marketplace order → HOLD → Machine executes → Signed telemetry (canonical CBOR)
   → Verification (signature, sequence, nonce, freshness, units) → Settlement
```

Implemented: required machine keys, provider-signed machine registration, signed telemetry with monotonic sequence, nonce anti-replay and timestamps, telemetry bound to the delivered report, settlement only with verified telemetry for the full quantity. Design: schema validation, retry and backoff, machine offline operation, a gateway. Future: hardware attestation. Signed telemetry proves which key signed a report, not that the physical service happened.

### H. Identity & authorization — Partial

```text
Identity → Authentication (Ed25519 signature) → Authorization (party of this order?) → Action
```

Security does not depend on caller-supplied role strings: every Marketplace and IoT action is a signed `ActorAuth`, admin and arbiter are verified against configured public keys, and order reads are limited to the order's parties. Missing: key rotation and revocation, identity suspension and revocation, Sybil resistance.

### I. Events / storage / API — Design

Planned separation:

```text
Economic state      →  Ledger
Operational state   →  Service / order state
Large data          →  External storage
Evidence            →  Hashes + references
```

There is no event bus yet; the planned events map to transitions that already exist in code. Large telemetry should never become a large object inside the ledger.

Lab: `src/service/uep-service-api.ts` and `uep-http-api.ts` (a versioned service API over HTTP), `storage-provider.ts` with memory, S3 and IPFS adapters (content-hash identity), and `observability.ts`. These are experimental inputs to the Phase 2 milestones (storage abstraction, local API), not the milestones themselves.

### J. SDK / developer platform — Design

```text
External application → SDK → API → Service layer → UEP protocol / Marketplace / IoT
```

Planned packages: `@uep/client`, `@uep/marketplace`, `@uep/iot-m2m`. Today developers import the TypeScript modules directly ([`API.md`](./API.md)).

### K. Node / infrastructure — Future

Planned roles: user, app/agent, node, validator, prover, oracle, relayer, storage. Not all of them are needed for the first multi-node testnet.

Labs: authenticated node envelopes, TCP transport and handshake, and pinned verifying keys (`src/lab/node-*.ts`, `verifying-key-registry.ts`); an agent-identity lab with owner-signed capabilities in `src/agent/`.

### L. Testnet — Implemented (testnet), local only

```text
Local single-node  ← today
       ↓
Multi-node local
       ↓
Public testnet
```

Reproduce everything with `npm run test:all`: the testnet part (`npm test`, `npm run smoke:testnet`, `npm run quickstart`, `npm run simulate:20k`) followed by the research labs (`npm run test:rust`, `npm run build:uep-zk`, `npm run test:lab`); see [`REPRODUCIBILITY.md`](./REPRODUCIBILITY.md). The testnet is not a real economy.

### M. Interplanetary extensions — Future

```text
EARTH → MOON → MARS → LAGRANGE → DEEP SPACE
```

Delayed messaging, delay-tolerant networking and `LOCK` / `MESSAGE` / `RECEIPT` / `SETTLEMENT` models are research tracks. The aim is an economic protocol that does not depend on constant terrestrial latency. Nothing here is operational.

Lab: `src/lab/uep-net-adapt/` simulates link observations, relays, topologies and a delay-tolerant bridge with mock or recorded-sample adapters. The `StarlinkAdapter` there is a simulator and interface placeholder, not a live integration; no real link is used.

### N. Public economic network — Design

```text
Services → Economic activity → Fees → Network infrastructure → Providers / Nodes / Oracles / Relayers
```

Not `Token → Speculation → Network`. A native token is not part of the required architecture.

## 5. Treasury boundary

Two concepts must not be confused:

1. **UEP testnet protocol treasury** — used by the reference transaction fee rule (0.1%, minimum 1 unit).
2. **Marketplace Treasury** — business-layer accounting for the 3% Marketplace fee (minimum 1 unit per settled order).

The Marketplace Treasury is not a native UEP token treasury.

## 6. Target architecture

```text
                         ┌───────────────────┐
                         │      UEP          │
                         │ Economic Protocol │
                         └─────────┬─────────┘
                                   │
             ┌─────────────────────┼─────────────────────┐
             │                     │                     │
          PEOPLE                 AGENTS               MACHINES
             │                     │                     │
             └─────────────────────┼─────────────────────┘
                                   │
                         SERVICE MARKETPLACE
                                   │
             ┌─────────────────────┼─────────────────────┐
             │                     │                     │
          COMPUTE                DATA                 IoT/M2M
             │                     │                     │
          STORAGE              ORACLES                ENERGY
             │                     │                     │
             └─────────────────────┼─────────────────────┘
                                   │
                            ECONOMIC STATE
                                   │
                         ┌─────────┼─────────┐
                         │         │         │
                       NOTES    NULLIFIERS  ROOTS
                         │         │         │
                         └─────────┼─────────┘
                                   │
                             VERIFICATION
                                   │
                              SETTLEMENT
                                   │
                               TREASURY
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
                  NODES         ORACLES        RELAYERS
                    │              │              │
                    └──────────────┼──────────────┘
                                   │
                            PUBLIC ECONOMY
                                   │
                         ┌─────────┴─────────┐
                         │                   │
                       EARTH               SPACE
                         │                   │
                         └─────── UEP ───────┘
```

This is the direction, not the current state. The current state is the table in section 2.


## Settlement, categories and oracle (v0.5.2; hardened in v0.5.3)

Added as **Implemented (testnet)** modules on top of the Marketplace:

- `src/settlement` — single payout executor behind Marketplace and category HOLDs. Marketplace `payout()` and category `settleHold()` go through it; one fee path (Marketplace fee on the provider part only).
- `src/category` — hashlock swap (bilateral; not the AMM lab pool in `src/lab/liquidity.ts`), relay, dispute, drip over once-issued Marketplace escrow/subsidy ports (no private ledgers). Relay pays 20 % custody / 80 % delivery after key publication.
- `src/oracle` — policy-evaluation oracle (repository Poseidon BN254 commitments, network-bound quotes since v0.5.3); `OraclePolicyGate` (v0.5.3) checks Marketplace listing prices, IoT tariffs and hashlock-swap rates and fails closed; never imported from core/testnet; never holds balances; not on the spend or consensus path.

v0.5.3 additions: settlement receipts v2 bind the `networkId`; settlement batches are anchored in ledger state (snapshot format 8) with RFC 9162 consistency proofs across batches; the asset registry is wired into the ledger; multi-input transactions (ADR 0004); relay/dispute fixes V52-01 … V52-03. Self-assessed coverage: [`REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md`](./REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md).

Attack-battery hardenings that land with these modules (still testnet only): process-local concurrent spend guard (`LEDGER_BUSY`) and `SpendSerializer`; `maxUnfundedReservationsPerListing`; optimistic `order.version` / `ORDER_STATE_CONFLICT`; paymaster sponsorship captured only on settle. Deferred: IoT hardware attestation (Evidence phase); HPKE for relay payloads.

See `docs/MODULES.md`, `docs/SETTLEMENT.md`, `docs/SETTLEMENT-BRIDGE.md`, `docs/CATEGORY-MODULES.md`, `docs/ORACLE.md`, `docs/THREAT-MODEL.md` and `docs/INTEGRATION-PLAN.md`.
