# Reproducibility Guide

## Environment

Use Node.js 22.6+. The research labs (steps 5–7 of `test:all`) also need Rust 1.85 with `cargo` and network access to crates.io for the first build.

The repository is intentionally dependency-light and uses Node's built-in
TypeScript type stripping for the reference test runner.

## Clean run

```bash
git clone https://github.com/UEPceo/UEP-Universal-Economic-Protocol.git
cd UEP-Universal-Economic-Protocol
npm ci
npm run test:all
```

`npm run test:all` runs `npm test` (protocol, Marketplace, IoT/M2M and scale suites), the smoke test, the quickstart and the 20k simulation, then the research labs: `test:rust`, `build:uep-zk` and `test:lab`. It stops at the first failure. The testnet part takes about a minute; the labs take about 5–10 minutes, including the first Rust build. CI runs the same command on Node.js 22.x and 24.x with Rust 1.85.1.

Expected results at `0.4.7-public-iot-m2m` (Node.js 22 and 24):

| Command | Expected |
|---|---|
| `npm run test:protocol` | 79/79 pass |
| `npm run test:marketplace` | 104/104 pass (includes the 23 IoT/M2M and the 3 scale tests) |
| `npm run test:scale` | 3/3 pass |
| `npm run test:iot` | 23/23 pass |
| `npm run smoke:testnet` | `SMOKE OK` |
| `npm run quickstart` | `PASS — local reference testnet` |
| `npm run simulate:20k` | 20,000 settled, 0 errors, `valueConserved: true` |
| `npm run test:rust` | uep-21-poseidon 7, uep-25-prototype 9, uep-26-spend-circuit 87 pass |
| `npm run build:uep-zk` | `uep-core/target/release/uep-zk` built from source |
| `npm run test:lab` | 92 files, 427 tests pass, 0 failures; 16 files with known issues skipped |

Lab suites with known failures are listed in `scripts/lab-known-issues.json` and skipped (see [`LABS.md`](./LABS.md)). Run them with `node scripts/test-lab.mjs --include-known`. The `uep-zk` binary hash depends on the toolchain and platform, so the labs do not pin it.

## Protocol only

```bash
npm run test:protocol
npm run smoke:testnet
```

## Marketplace only

```bash
npm run test:marketplace
npm run test:iot
npm run test:scale
npm run simulate:20k
```

## Determinism

For protocol experiments, record:

- Git commit SHA;
- Node.js version;
- operating system;
- command executed;
- test output;
- any modified protocol parameters.

Do not publish secrets as part of a reproduction bundle.

## What a benchmark means

A local benchmark measures the implementation under the stated local conditions.
It does not establish Internet TPS, public-network throughput or economic capacity.

## Transaction evidence

The public smoke test prints:

- network ID;
- transaction ID;
- sender;
- recipient;
- amount;
- fee;
- nullifier;
- state root;
- verification result.

This is suitable for reproducing the project's first-transaction style milestone,
while remaining explicit that it is a local reference transaction rather than a
production globally finalized transaction.
