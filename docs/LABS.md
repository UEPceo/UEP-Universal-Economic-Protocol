# UEP research labs

This repository contains two kinds of code:

| | Where | Status |
|---|---|---|
| **Public reference testnet** | `src/core`, `src/testnet`, `src/identity`, `src/marketplace`, `src/settlement`, `src/category`, `src/oracle`, `src/service/iot-m2m*`, `src/network` | Hardened testnet code (see `CHANGELOG.md`). This is the source of truth for protocol rules. |
| **Research labs** | `src/lab`, `src/agent`, the service/API lab in `src/service`, `uep-core/` (Rust) | Experimental. Local, in-process or local multi-process only. **Not** a network, **not** production, no security claim. |

These components were internal lab experiments during the project's early stage.
They are now public, as **experimental** code, so that the whole project can be
built and tested in one place. They do not change the public protocol rules: where a lab depends on a
protocol primitive (fees, hashes, SMT, notes, addresses), it imports the public
hardened implementation from `src/core`.

No native token is introduced. The protocol fee stays at 0.1% and the
Marketplace fee at 3%. The AMM lab pool (`src/lab/liquidity.ts`; not the testnet hashlock swap in
`src/category/swap.ts`) has its own
pool fee inside its simulation (see "Liquidity-pool lab fee" below). Nothing in
the testnet charges it. All keys used by the labs are generated locally at run time
or are trivial fixed test vectors (for example `secret = 1`, `salt = 2`); none has
any value. The Groth16 keys produced by `uep-zk` are development keys: there is no
ceremony. The verifying keys pinned in `uep-core/vectors/UEP-ZK-DEV-VK-PINS.json`
are those development keys: pinning decides which key a verifier uses, it does
not make the key trustworthy. **ZK verification in the labs is not trustworthy
until a real multi-party setup ceremony is held**; the pinned keys are for
development and tests only and are refused when `NODE_ENV=production`
or `UEP_ZK_KEY_MODE=production` is set. See `SECURITY.md`.

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
| Rust / ZK | `uep-core/uep-21-poseidon`, `uep-23-state-transition`, `uep-24-atomic`, `uep-25-prototype`, `uep-26-spend-circuit` | Poseidon BN254 (t=3, α=5) + R1CS, the UEP-25 reference state machine, the UEP-26 spend circuit and `uep-zk` CLI |
| Design notes | `uep-core/*.md`, `uep-core/docs/` | Lab design notes by milestone, indexed in [`uep-core/README.md`](../uep-core/README.md). Historical notes say so in their first line; status words in the notes are lab status, not production claims. |

`uep-core/uep-23-state-transition` (one-leaf transition) and `uep-core/uep-24-atomic`
(sender/recipient/treasury model; the SMT is an interface) were ported to the pinned
arkworks 0.3 API in v0.5.3 and are built and tested by `npm run test:rust`. They remain lab code.

## How to run

```bash
npm run test:all      # whole suite: testnet + Marketplace + IoT + smoke + 20k + Rust + labs
npm run test:rust     # cargo test for uep-21, uep-25, uep-26 (needs Rust and crates.io)
npm run build:uep-zk  # builds uep-core/target/release/uep-zk from source
npm run test:lab      # lab suites (needs the uep-zk binary)
npm run test:lab -- uep36   # only files whose path contains "uep36"
npm run test:lab:known      # only the files with known issues (non-blocking in CI)
```

No prebuilt binary is committed. `uep-zk` is always built from source. Lab benchmarks write their reports to `artifacts/`, which is git-ignored.

## Liquidity-pool lab fee

Simulation only. The constant-product pool lab charges a **0.3% total swap fee**
on the input, split in two configurable parts (`feePpm`, `protocolFeePpm`, in
parts per million):

| Part | Default | Where it goes |
|---|---|---|
| Protocol share | 0.1% (`protocolFeePpm = 1000`) | Leaves the pool and is accounted per asset in `protocolFeesA/B` (the protocol treasury in the simulation) |
| Liquidity-provider share | 0.2% (`feePpm - protocolFeePpm = 2000`) | Stays in the reserves, so the pool invariant `k` grows for the liquidity providers |

Why: 0.3% is the usual constant-product fee level, high enough to pay liquidity
providers for price risk and low enough not to push volume away. The protocol
share uses the same 0.1% rate as the protocol fee, so a swap never charges the
protocol more than a normal transfer does, and two thirds of the fee stays with
the people who provide the liquidity. The parameters are validated
(`0 <= protocolFeePpm <= feePpm < 1_000_000`); the output is rounded down, in
favour of the pool. There is no native token, and this fee is not part of the
public testnet rules.

## Differences between the labs and the public core

Status of the design points found when the labs were published. Where something
is still open, the public core is authoritative and the affected lab checks are
skipped with a note in the test.

1. **Hash: resolved.** There is one canonical protocol hash: Poseidon over BN254
   (x^5, t = 3, 8 full + 57 partial rounds, circomlib-compatible constants), in
   `src/core/poseidon.ts`. The core's note commitments, nullifiers and SMT hashing
   use it, and so do the ZK circuit and the labs. It is checked against the
   `uep-core/vectors` (uep-21) test vectors. The older ordered SHA-256→BN254 hash
   is kept only as an inactive reference (`Sha256FieldReferenceHash`). Snapshot
   format 6 marks the change (see `CHANGELOG.md`).
2. **State tree layout: open.** The public ledger keys its SMT with the full
   254-bit field value. The UEP-26 circuit and the consensus SMT labs keep a
   32-level tree keyed by the low bits of the key and reject key collisions. A
   254-level circuit costs about 1.0M constraints (6–7× the current 155k), which
   makes proving in the lab suite impractical; it stays a lab limitation.
   v0.5.0 (circuit v4): every slot is keyed by `H_ACCOUNT(account, asset)`
   (the same injective (account, asset) key as the core), the circuit itself
   constrains each index to the low bits of that key and requires the sender,
   recipient and treasury slots to be distinct; the witness builder, the
   execution engine and the SMT economic state reject an index collision
   (`SMT_INDEX_COLLISION`) instead of overwriting a leaf. Small test depths (8)
   pick lab account ids with distinct slots.
3. **Fee for small amounts: resolved.** Core and circuit (v3 fee floor, current
   tag `UEP-27-SPEND-POSEIDON-D32-v4-assetkey`) both use `fee = max(1, floor(amount/1000))`,
   and the circuit rejects `amount = 0`. The UEP-25 reference state machine uses
   the same rule.
4. **Account ids: open.** Public accounts are key-derived (SHA-256 of the Ed25519
   spend key, v0.4.5). The circuit still proves the older Poseidon
   `H_ACCOUNT(secret, salt)` binding, because proving key ownership in the circuit
   needs a circuit-friendly signature (for example EdDSA over BabyJubJub). The two
   tests that need the shared derivation stay skipped. Plan for the next
   milestone: derive the spend key on BabyJubJub, define the key-derived account
   as a Poseidon hash of that public key, and verify an in-circuit EdDSA-Poseidon
   signature over the transaction commitment (roughly 6–8k extra constraints for
   the signature check, plus the key hash), with a migration path from the
   Ed25519 key-derived accounts of the testnet. It was not implemented in v0.5.0:
   it changes the account derivation, the wallet and the snapshot format at once.
   **v0.5.3 adapter:** the witness contract checks the core derivation by default
   and the circuit derivation only in an explicit mode
   (`accountIdDerivation: "circuit-h-account"`, `circuitAccountId()` in
   `src/core/zk-tx-adapter.ts`); the two witness-contract tests are unskipped and
   cover both modes. The ledger accepts a `zk-spend` only with a configured
   verifier, after binding public inputs 4..11 (ids, asset, amount, fee, nullifier,
   commitment) to the transaction; the sender signature is still required because
   the circuit does not prove the key-derived id.
7. **Crypto alignment, what remains (v0.5.3, precise list):**
   - roots (public inputs 0..3) are not bound to the ledger: core SMT depth 254
     (full key) vs circuit depth 32 (low bits, `circuitSlotIndex`);
   - account ids: circuit proves H_ACCOUNT(secret, salt), core uses Ed25519
     key-derived ids (needs BabyJubJub EdDSA-Poseidon in the circuit);
   - the circuit proves one nullifier: multi-input transactions (ADR 0004) cannot
     use zk-spend;
   - the ledger verifier hook is synchronous; the Groth16 verifier is the lab
     `uep-zk` binary (asynchronous), so no production verifier is wired;
   - snapshot restore does not re-verify zk-spend proofs (it re-checks signatures,
     nullifier sets and commitments);
   - Groth16 keys are development keys from a public seed; a verifier with
     `keyMode: "development"` is refused under NODE_ENV=production (ledger) and the
     lab pins refuse them too (`src/lab/zk-vk-pins.ts`). No ceremony has been run.
5. **Address v1: resolved.** Retired in the public core and in the labs; labs use v2.
6. **Domain binding: resolved.** The ZK verification helpers require the expected
   `domain_id` and reject a proof for another domain (public input 12).

## Lab test status

Some lab suites have known failures that come from the labs themselves (for
example, later lab milestones changed rules that older lab tests still assume).
They are listed in [`scripts/lab-known-issues.json`](../scripts/lab-known-issues.json)
with a reason, skipped by `npm run test:lab`, and can be run with
`npm run test:lab:known` (only those files) or
`node scripts/test-lab.mjs --include-known` (everything). In CI they run in a
separate non-blocking job, so the CI badge reflects the core.

**v0.5.3: from 14 files to 2.** Most known failures were not consensus bugs but
a race in the lab TCP mesh: when two nodes dialled each other at the same time,
each kept its own socket and closed the other one, so both sockets could die and
the pair stayed disconnected; tests then proposed on a partial mesh and timed
out. Both ends now keep the same socket (the one opened by the smaller node id,
`src/lab/uep35-tcp-mesh.ts`), and `ProcessCluster.start()` waits until every node
reports every other node as a peer. `uep35.7.1-consensus` also needed the economic
commitment on single-batch proposals. The 12 files that left the list passed
three or more consecutive runs on Node.js 22 and 24 and now block CI. Remaining:
`uep37.5-stress` (Poseidon-zk proving time on 4 processes exceeds the timeout
under load) and `uep38-p4-view-mesh` (delivery after a TCP view change; needs a
catch-up path).

Individual lab tests that are still skipped, each with a note in the test:

- two tests that pin the SHA-256 of a prebuilt `uep-zk` binary; the binary is
  built from source and its hash depends on the toolchain and platform.
