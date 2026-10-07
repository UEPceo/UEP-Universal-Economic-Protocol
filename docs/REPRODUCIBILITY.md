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

`npm run test:all` runs `npm run test:core` (`npm run lint:determinism`, `npm run check:snapshot-compat`, `npm run check:donation`, `npm test` with the protocol, Marketplace, IoT/M2M, settlement, oracle and category suites, `npm run test:poisoned-clock`, the smoke test, the quickstart, the 20k simulation and `test:rust`), then `build:uep-zk` and `test:lab`. It stops at the first failure. The testnet part takes a few minutes (the protocol suite alone about a minute); the labs take about 8–15 minutes more, including the first Rust build. CI runs `test:core` on Node.js 22.x and 24.x with Rust 1.85.1 and the labs in a separate job; both are blocking. A non-blocking job runs the 2 known-issue lab files.

Expected results for `0.5.3-public-iot-m2m` (branch `v0.5.3-fixes`, Node.js 22 and 24). Last re-checked with `npm run test:all` on Node.js 22.23 and 24.21 with Rust 1.85.1 on 2026-10-07:

| Command | Expected |
|---|---|
| `npm run lint:determinism` | 126 files scanned, 0 violations |
| `npm run check:snapshot-compat` | `format 8, 2 migration step(s) from format 6, fixtures and FORMAT.json consistent` |
| `npm run check:donation` | the donation address decodes as bech32 (checksum OK) and is the only BTC address in the docs |
| `npm run test:protocol` | 172/172 pass, including every golden snapshot fixture and the cryptographic test vectors (about a minute: Poseidon in TypeScript) |
| `npm run test:marketplace` | 178/178 pass (Marketplace, IoT/M2M, HTTP authorization, compatibility shims, height producer, poisoned-clock helpers, scale, attack battery, Marketplace snapshot) |
| `npm run test:settlement` | 17/17 pass |
| `npm run test:oracle` | 20/20 pass |
| `npm run test:category` | 18/18 pass |
| `npm run test:poisoned-clock` | 360/360 pass with 0 poisoned-clock violations |
| `npm run smoke:testnet` | `SMOKE OK` |
| `npm run quickstart` | `PASS — local reference testnet` |
| `npm run simulate:20k` | 20,000 settled, 0 errors, `hotExpired: 100`, `valueConserved: true` |
| `npm run test:rust` | 127 pass: uep-21-poseidon 7, uep-25-prototype 9, uep-26-spend-circuit 99, uep-23-state-transition 6, uep-24-atomic 6 |
| `npm run build:uep-zk` | `uep-core/target/release/uep-zk` built from source |
| `npm run test:lab` | 110 files, 528 tests pass, 0 failures; 2 files with known issues skipped |
| `npm run test:lab:known` | the 2 known-issue files (`uep37.5-stress`, `uep38-p4-view-mesh`); failures expected (non-blocking CI job) |

`src/testnet/key-derived-accounts.test.ts` uses fixed account vectors (no random account ids; the only random values are ephemeral snapshot and faucet keys, which do not change any outcome), so repeated runs give the same result; it was run 400 times on Node.js 22 with 0 failures:

    for i in $(seq 1 400); do node --experimental-strip-types --no-warnings --test src/testnet/key-derived-accounts.test.ts >/dev/null || echo FAIL $i; done

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
