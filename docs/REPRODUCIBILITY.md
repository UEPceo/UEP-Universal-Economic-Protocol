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

`npm run test:all` runs `npm test` (protocol, Marketplace, IoT/M2M and scale suites), the smoke test, the quickstart and the 20k simulation, then the research labs: `test:rust`, `build:uep-zk` and `test:lab`. It stops at the first failure. The testnet part takes a few minutes (the protocol suite alone about a minute); the labs take about 5–10 minutes more, including the first Rust build. A clean run on a typical machine takes roughly 10 minutes in total. CI runs the same command on Node.js 22.x and 24.x with Rust 1.85.1 as a blocking job, plus a non-blocking job for the known-issue lab files.

Expected results for `0.5.0-public-iot-m2m` (unreleased; Node.js 22 and 24). Last re-checked with `npm run test:all` on Node.js 22.23 and 24.21 with Rust 1.85.1 on 2026-10-03:

| Command | Expected |
|---|---|
| `npm run test:protocol` | @@PROTO@@/@@PROTO@@ pass (about a minute: Poseidon in TypeScript) |
| `npm run test:marketplace` | @@MKT@@/@@MKT@@ pass (includes the @@IOT@@ IoT/M2M, the 11 HTTP authorization and the 3 scale tests) |
| `npm run test:scale` | 3/3 pass |
| `npm run test:iot` | @@IOT@@/@@IOT@@ pass |
| `npm run smoke:testnet` | `SMOKE OK` |
| `npm run quickstart` | `PASS — local reference testnet` |
| `npm run simulate:20k` | 20,000 settled, 0 errors, `valueConserved: true` |
| `npm run test:rust` | @@RUST@@ |
| `npm run build:uep-zk` | `uep-core/target/release/uep-zk` built from source |
| `npm run test:lab` | @@LABLINE@@; 14 files with known issues skipped |
| `npm run test:lab:known` | the 14 known-issue files; failures expected (non-blocking CI job) |

Lab suites with known failures are listed in `scripts/lab-known-issues.json` and skipped (see [`LABS.md`](./LABS.md)). Run them with `node scripts/test-lab.mjs --include-known`. The `uep-zk` binary hash depends on the toolchain and platform, so the labs do not pin it.

To run part of the labs, pass a path fragment: `npm run test:lab -- uep-econ` runs only the lab files whose path contains `uep-econ`.

## If something fails

- `node: bad option: --experimental-strip-types`: Node.js is older than 22.6. Upgrade Node.js.
- `cargo: command not found` or a Rust build error: install Rust 1.85 (CI uses 1.85.1); `npm test` and the testnet steps do not need it.
- `uep-zk not found`: run `npm run build:uep-zk` before `npm run test:lab`, or set `UEP_ZK_BIN`.
- A failure in a lab file listed in `scripts/lab-known-issues.json` is expected; those files are skipped by `npm run test:lab`.

Please report any other failure with the information listed under "Determinism" below ([bug report form](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/issues/new?template=bug_report.yml)).

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
