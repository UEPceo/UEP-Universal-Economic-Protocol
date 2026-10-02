# Public Architecture

This document describes the UEP architecture as fourteen layers (A–N), what of each layer exists in this repository today, and how the implemented parts fit together. The phases that complete each layer are in [`ROADMAP.md`](../ROADMAP.md).

Everything described as implemented runs on the **local, single-node, in-process testnet**. Nothing here is a production network, and there is no native UEP token.

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

| Layer | Status | In this repository today | Main gaps |
|---|---|---|---|
| **A. Core protocol** | Implemented (testnet) | `src/core`: transactions and TxIDs, nonces, notes, commitments, nullifiers, state roots, state transition, 0.1% fee with a 1-unit floor, value conservation | Multi-input spends (nullifier vector) |
| **B. Economic state / ledger** | Implemented (testnet) | `src/testnet/ledger.ts`: 254-bit SMT, note-commitment Merkle tree, Ed25519 k-of-n hash-chained snapshots, signed mints, validated pending queue | One input note per spend; guaranteed multi-asset semantics |
| **C. Cryptography / ZK** | Partial | SHA-256-to-BN254 reference hash (not Poseidon), Ed25519 via `node:crypto`, SMT, note tree, ZK witness contract (not wired), development spend MAC | Production circuits and Poseidon, witness range checks (UEP-A22), production keys and ceremony |
| **D. Consensus & network** | Future | A `local://` testnet profile only | Replication, consensus, P2P |
| **E. Marketplace** | Implemented (testnet) | `src/marketplace`: listings, funded reservations, HOLD, delivery, disputes with an arbiter, settlement, treasury, paymaster, reputation | Marketplace snapshot/restore; service schemas and SLA; a real payment rail |
| **F. Service plane** | Partial | Signed identities, IoT provider and machine registries, listings as the service registry, `attachCategoryService()` | A decoupled layer with typed registries and identity states; a generic execution interface |
| **G. IoT / M2M** | Implemented (testnet) | `src/service/iot-m2m*.ts`: machine Ed25519 keys, signed canonical-CBOR telemetry, anti-replay, settlement against verified telemetry | Gateway, retry/backoff, machine offline mode, schema validation, physical attestation |
| **H. Identity & authorization** | Partial | Key-derived accounts, `uep1` Bech32m addresses, a signed `ActorAuth` on every action, admin and arbiter keys | Key rotation and revocation, suspended/revoked states, Sybil resistance |
| **I. Events / storage / API** | Design | Content hashes as delivery evidence; all state is in memory | Event bus, storage abstraction, network API |
| **J. SDK / developer platform** | Design | TypeScript library API ([`API.md`](./API.md)), the first-transaction example, test kits | `@uep/*` packages, CLI, sandbox |
| **K. Node / infrastructure** | Future | Role separation inside one node: snapshot authority, faucet key, verify-only node | Node processes, validators, provers, oracles, relayers |
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
│           UEP DIGITAL MARKETPLACE            │
│ listings · orders · HOLD · delivery · fees   │
│ disputes · treasury · reputation · paymaster │
└───────────────────────┬──────────────────────┘
                        │
                        │ business-layer boundary
                        ▼
┌──────────────────────────────────────────────┐
│                 UEP TESTNET                  │
│ identities · notes · transactions · SMT      │
│ nullifiers · fees · local state transition   │
└──────────────────────────────────────────────┘
```

### Why the layers are separate

The Marketplace is a business application. UEP core is an economic state-transition
reference implementation. Keeping the boundary explicit prevents the public release
from implying that a marketplace order automatically becomes a consensus-finalized
protocol transaction. Marketplace balances are business-layer accounting; there is no
verified bridge from the ledger yet.

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

Known limits: one input note per transaction (UEP-C04), so a balance split across notes cannot be spent at once. The ledger stores several assets, but multi-asset semantics are not yet a guaranteed property (see the roadmap).

### C. Cryptography / ZK — Partial

```text
CRYPTOGRAPHIC FOUNDATION
        │
        ├── Implemented (testnet): SHA-256→BN254 reference hash, Ed25519,
        │                          SMT, note tree, commitments, nullifiers
        │
        ├── Testnet: development spend MAC + mandatory Ed25519 sender signature
        │
        └── Production ZK: separate milestone, not in this repository
```

The public release uses deterministic field/hash/commitment primitives and the
reference development spend-MAC path, plus Ed25519 (`node:crypto`) signatures for
sender spend keys, snapshots, mints, Marketplace actions and IoT telemetry. The active hash is a SHA-256-to-field reference backend, not Poseidon. The ZK witness contract is not wired into the transaction path and has no range checks yet (UEP-A22). The repository deliberately does not claim a production Groth16/Nova deployment. A development circuit is never treated as production ZK.

### D. Consensus & network — Future

```text
Users → Apps / Agents → Nodes → Validators / Provers → Relayers → Oracles → Storage
```

The repository has one `local://uep-testnet-1` profile and no consensus or P2P code. Signed, hash-chained snapshots and verify-only restore are the groundwork for replication. Planned evolution: local testnet → multi-node testnet → distributed testnet → public testnet → production network.

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

### J. SDK / developer platform — Design

```text
External application → SDK → API → Service layer → UEP protocol / Marketplace / IoT
```

Planned packages: `@uep/client`, `@uep/marketplace`, `@uep/iot-m2m`. Today developers import the TypeScript modules directly ([`API.md`](./API.md)).

### K. Node / infrastructure — Future

Planned roles: user, app/agent, node, validator, prover, oracle, relayer, storage. Not all of them are needed for the first multi-node testnet.

### L. Testnet — Implemented (testnet), local only

```text
Local single-node  ← today
       ↓
Multi-node local
       ↓
Public testnet
```

Reproduce with `npm test`, `npm run smoke:testnet`, `npm run quickstart` and `npm run simulate:20k` ([`REPRODUCIBILITY.md`](./REPRODUCIBILITY.md)). The testnet is not a real economy.

### M. Interplanetary extensions — Future

```text
EARTH → MOON → MARS → LAGRANGE → DEEP SPACE
```

Delayed messaging, delay-tolerant networking and `LOCK` / `MESSAGE` / `RECEIPT` / `SETTLEMENT` models are research tracks. The aim is an economic protocol that does not depend on constant terrestrial latency. Nothing here is operational.

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
