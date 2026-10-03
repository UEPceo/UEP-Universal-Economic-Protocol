# uep-core — research labs (experimental)

This directory holds the Rust/ZK research crates of UEP and the design notes that
were written, milestone by milestone, while the labs were developed. Everything
here is **experimental**: it is built and tested by `npm run test:all`, but it is
not part of the public testnet rules (those live in `src/core` and `src/testnet`)
and it carries no security claim. See [`../docs/LABS.md`](../docs/LABS.md) for the
scope of the labs and the known differences between the labs and the testnet core.

No production ceremony has been performed. All Groth16 keys produced here are
development keys from a seeded setup.

## Rust crates

| Crate | What it is | Tested by |
|---|---|---|
| [`uep-21-poseidon/`](./uep-21-poseidon/README.md) | Poseidon over BN254 (x^5, t = 3) and its R1CS gadget; source of the vectors used by the TypeScript core | `npm run test:rust` (7 tests) |
| `uep-25-prototype/` | UEP-25 reference state machine with adversarial tests ([spec](./uep-25-prototype/docs/UEP-25-SPEC.md)) | `npm run test:rust` (9 tests) |
| [`uep-26-spend-circuit/`](./uep-26-spend-circuit/README.md) | UEP-26 Groth16 spend circuit (v4, `UEP-27-SPEND-POSEIDON-D32-v4-assetkey`) and the `uep-zk` CLI | `npm run test:rust` (91 tests); `npm run build:uep-zk`; `npm run smoke:zk` |
| [`uep-23-state-transition/`](./uep-23-state-transition/README.md), [`uep-24-atomic/`](./uep-24-atomic/README.md) | Historical scaffolds, kept for reference | Not built, not tested |

Build and run instructions for `uep-zk`: [`UEP-ZK-BUILD-AND-RUN.md`](./UEP-ZK-BUILD-AND-RUN.md).

Other directories: `vectors/` (Poseidon and SMT golden vectors), `benchmarks/`
(recorded outputs of lab benchmarks), `docs/` (lab service API, storage and
observability notes), `uep-32-e2e-evidence/` (lab end-to-end evidence).

## How to read the design notes

The `UEP-*.md` files are **lab notes**, not specifications of the testnet. Keep in mind:

- **Status words are lab status.** Markers such as `DEMONSTRATED`, `FROZEN`,
  `CLOSED`, `COMPLETED`, `GOLDEN` or 🟢 describe the state of a lab experiment when
  the note was written. They do not mean production-ready, and they do not mean
  the testnet uses that mechanism.
- **Historical notes.** Notes superseded by later work say so in their first line
  (for example the circuit-size notes that predate circuit v3). Where a note and
  [`../docs/LABS.md`](../docs/LABS.md) disagree, `LABS.md` and the code are
  authoritative.
- **Test commands.** Many notes cite per-milestone scripts from the internal
  development workspace, such as `npm run test:33`, `test:34`, `test:36.x`,
  `test:e2e`, `test:econ-01` or `bench:30.1`. These scripts do not exist in this
  repository's `package.json`. Run the matching lab files with
  `npm run test:lab -- <path fragment>`, for example `npm run test:lab -- uep33`
  or `npm run test:lab -- uep-econ-01`. Test counts quoted in older notes are
  the counts at the time of writing; the current totals are in
  [`../docs/REPRODUCIBILITY.md`](../docs/REPRODUCIBILITY.md).
- **Multi-host and multi-machine.** Notes that describe multi-host or "machines"
  set-ups refer to lab runs; in this repository's CI the labs run on one machine
  (in-process, or local processes over TCP on 127.0.0.1).
- **Paths.** Files referenced as `src/...` are in this repository, mostly under
  `src/lab/`. A few notes mention internal files that were not published; they
  say so.

## Index of design notes

| Area | Notes |
|---|---|
| Hash, vectors and ZK spend circuit | `UEP-26-HASH-PARAMETERS-FREEZE`, `UEP-26-POSEIDON-TEST-VECTORS`, `UEP-26-SPEND-CIRCUIT-SPEC`, `UEP-26-TEST-VECTORS`, `UEP-28.3-ZK-WITNESS-CONTRACT`, `UEP-28.6-POSEIDON-WALLET-PROVE-JSON`, `UEP-29.4-CLOSED`, `UEP-37.1-LEAF-ENCODING-FREEZE`, `UEP-37.2-POSEIDON-GOLDEN`, `UEP-38.34-CONSTRAINTS`, `UEP-38.35-CIRCUIT-FREEZE`, `UEP-CEREMONY-REHEARSAL`, `UEP-D32-NAMESPACE-NOTE`, `UEP-ZK-BUILD-AND-RUN`, `UEP-ZK-WEBWORKER-0.1` |
| Ledger lab, policy, oracles and liquidity | `UEP-28-SECURITY-ORACLE-LIQUIDITY`, `UEP-28.1-PUBLIC-INPUTS-AND-SWAPS`, `UEP-28.2-SIGNED-POOL-LEG`, `UEP-28.5-NODE-VERIFY-NO-SECRETS`, `UEP-28.11-CANONICAL-STATE-AND-LAB`, `UEP-UNITS`, `UEP-MULTI-ASSET-CHECKPOINT` |
| Execution engine | `UEP-30-EXECUTION-ENGINE`, `UEP-30.2-PARALLEL-SCHEDULER`, `UEP-30.3-PERSISTENCE` |
| Nodes, transport and authenticated replication | `UEP-31-MULTI-NODE-LAB`, `UEP-31.1-TCP-TRANSPORT`, `UEP-32-AUTH-MULTI-NODE`, `UEP-32.5-ZK-AUTH-ACCEPT`, `UEP-33-MULTI-MACHINE-LAB`, `UEP-33.1-ZK-CLUSTER`, `uep-32-e2e-evidence/` |
| Consensus experiments | `UEP-34-CONSENSUS-RESEARCH`, `UEP-34-FREEZE`, `UEP-34.4-FORMAL-CONSENSUS-SAFETY`, `UEP-34.5-COMMIT-CERT`, `UEP-34.6-APPLY-COMMIT-CERT`, `UEP-35.0-FINALITY` to `UEP-35.11-PARTITION-RECOVERY`, `UEP-36-MULTI-LEADER` to `UEP-36.10-AGGREGATE-FREEZE` (except 36.2), `UEP-37.0-SMT-CONSENSUS-STATE`, `UEP-37.3-STATE-WITNESS` to `UEP-37.7.2-VIEW-CHANGE-QC` |
| Consensus ↔ ZK bridge | `UEP-38.0-PHASE4-BRIDGE`, `UEP-38.1-D32-NODE-VERIFY`, `UEP-P4-STAGING`, `UEP-25-VS-37-ARCHITECTURE` |
| Economic labs | `UEP-ECON-01` to `UEP-ECON-05`, `UEP-ECON-05.2-PROCESS-MESH` |
| Addresses and payment requests | `UEP-ADDR-001-ADDRESS-IDENTITY`, `UEP-ADDR-002-ENCODING`, `UEP-ADDR-003-PAYMENT-REQUEST` |
| Network adaptation (simulation) | `UEP-NET-001`, `UEP-NET-ADAPT`, `UEP-STARLINK-ADAPTER` |
| Service/API layer and agents | `UEP-36.2-API-SERVICE-LAYER`, `docs/UEP-API-001`, `docs/UEP-STORAGE-001`, `docs/UEP-OBSERVABILITY-001`, `UEP-AGENT-FOUNDATION` |
| Early Marketplace, IoT/M2M and paymaster notes | `UEP-DIGITAL-MARKETPLACE-0.1` (describes v0.2), `UEP-DIGITAL-MARKETPLACE-RELEASE-0.2`, `UEP-IOT-M2M-SERVICE-0.1`, `UEP-IOT-M2M-SERVICE-0.2`, `UEP-PAYMASTER-ECONOMY-0.1`, `UEP-PAYMASTER-ZK-WORKER-RELEASE-0.1-2026-10-01`, `UEP-MARKETPLACE-20K-SCALE-SIMULATION-2026-10-01` |

The early Marketplace and IoT/M2M notes predate the hardened public releases
(v0.4.1 – v0.4.7). The current behaviour of those layers is described in the
top-level [`README.md`](../README.md), [`CHANGELOG.md`](../CHANGELOG.md) and
[`docs/API.md`](../docs/API.md).
