# UEP research labs

This repository contains two kinds of code:

| | Where | Status |
|---|---|---|
| **Public reference testnet** | `src/core`, `src/testnet`, `src/identity`, `src/marketplace`, `src/service/iot-m2m*`, `src/network` | Hardened testnet code (see `CHANGELOG.md`). This is the source of truth for protocol rules. |
| **Research labs** | `src/lab`, `src/agent`, the service/API lab in `src/service`, `uep-core/` (Rust) | Experimental. Local, in-process or local multi-process only. **Not** a network, **not** production, no security claim. |

The labs are published so that the whole project can be built and tested in one
place. They do not change the public protocol rules: where a lab depends on a
protocol primitive (fees, hashes, SMT, notes, addresses), it imports the public
hardened implementation from `src/core`.

No native token is introduced. The protocol fee stays at 0.1% and the
Marketplace fee at 3%. The liquidity-pool lab (`src/lab/liquidity.ts`) has a 0.3%
swap-fee parameter inside its simulation. It is not a protocol fee and nothing in
the testnet charges it. All keys used by the labs are generated locally at run time
or are trivial fixed test vectors (for example `secret = 1`, `salt = 2`); none has
any value. The Groth16 keys produced by `uep-zk` are development keys: there is no
ceremony.

## What is in the labs

| Area | Path | What it explores |
|---|---|---|
| Execution engine | `src/lab/execution-engine.ts`, `conflict-scheduler.ts`, `engine-persistence.ts` | Sequential and wave-parallel state transitions, persistence |
| Node protocol and transport | `src/lab/node-*.ts`, `e2e-pipeline.ts`, `verifying-key-registry.ts` | Authenticated envelopes, TCP transport, handshake, pinned verifying keys |
| Consensus labs | `src/lab/uep34-*`, `uep35-*`, `uep36-*`, `uep37-*`, `uep38-*` | Leader election, quorum, commit certificates, BFT gate, DAG dissemination, partitions and recovery, multi-leader aggregates, view change, SMT economic state on the consensus path, ZK-verified apply |
| Economic labs | `src/lab/uep-econ-*` | Economically meaningful transactions, service settlement, escrow/holds, canonical economic tip, dispute liveness |
| Addresses and payment requests | `src/lab/address-v2.ts`, `bech32m.ts`, `payment-request.ts`, `payment-to-intent.ts` | Address encoding, signed payment requests |
| Network adaptation | `src/lab/uep-net-adapt/` | Simulated link observations, relay and delay-tolerant bridging (simulation only) |
| ZK bridge | `src/lab/zk-*.ts`, `poseidon-*.ts`, `uep-zk-runner.ts` | Calling the Rust `uep-zk` helper: prove, verify, Poseidon leaves |
| Agents | `src/agent/` | Agent identity, owner-signed capabilities, signed action requests, nonce windows |
| Service/API layer | `src/service/uep-*.ts`, `storage-provider.ts`, `memory-storage.ts`, `s3-adapter.ts`, `ipfs-adapter.ts`, `observability.ts`, `groth16-spend-queue.ts` | A versioned service API over HTTP, storage abstraction with content hashes, observability |
| Rust / ZK | `uep-core/uep-21-poseidon`, `uep-25-prototype`, `uep-26-spend-circuit` | Poseidon BN254 (t=3, α=5) + R1CS, the UEP-25 reference state machine, the UEP-26 spend circuit and `uep-zk` CLI |
| Design notes | `uep-core/*.md`, `uep-core/docs/` | Lab design notes by milestone. Historical notes say so in their first line. |

`uep-core/uep-23-state-transition` and `uep-core/uep-24-atomic` are historical
scaffolds kept for reference; they do not compile and are not tested.

## How to run

```bash
npm run test:all      # whole suite: testnet + Marketplace + IoT + smoke + 20k + Rust + labs
npm run test:rust     # cargo test for uep-21, uep-25, uep-26 (needs Rust and crates.io)
npm run build:uep-zk  # builds uep-core/target/release/uep-zk from source
npm run test:lab      # lab suites (needs the uep-zk binary)
npm run test:lab -- uep36   # only files whose path contains "uep36"
```

No prebuilt binary is committed. `uep-zk` is always built from source. Lab benchmarks write their reports to `artifacts/`, which is git-ignored.

## Known differences between the labs and the public core

These are open design points. Until they are decided, the public core is
authoritative and the affected lab checks are skipped with a note in the test.

1. **Hash.** The public core uses an ordered SHA-256→BN254 reference hash. The ZK
   circuit and the Poseidon labs use Poseidon BN254. A coordinated migration is
   pending.
2. **State tree layout.** The public ledger keys its SMT with the full 254-bit
   field value. The UEP-26 circuit and the consensus SMT labs use their own fixed
   tree depth. Aligning them is pending.
3. **Fee for small amounts.** The public core charges a minimum protocol fee of
   one unit (0.1% with a 1-unit floor). The circuit computes `floor(amount/1000)`
   with no minimum. Lab tests that prove a spend below 1,000 units therefore
   cannot build a proof and are skipped.
4. **Account ids.** Public accounts are key-derived (v0.4.5). The circuit proves
   the older `H_ACCOUNT(secret, salt)` binding.
5. **Address v1.** Retired in the public core; labs use v2.

## Lab test status

Some lab suites have known failures that come from the labs themselves (for
example, later lab milestones changed rules that older lab tests still assume).
They are listed in [`scripts/lab-known-issues.json`](../scripts/lab-known-issues.json)
with a reason, skipped by `npm run test:lab`, and can be run with
`node scripts/test-lab.mjs --include-known`.
