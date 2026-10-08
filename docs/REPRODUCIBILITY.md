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

`npm run test:all` runs `npm run test:core` (`npm run lint:determinism`, `npm run check:snapshot-compat`, `npm run check:donation`, `npm test` with the protocol, Marketplace, IoT/M2M, settlement, oracle and category suites, `npm run test:poisoned-clock`, the smoke test, the quickstart, the 20k simulation and `test:rust`), then `build:uep-zk` and `test:lab`. It stops at the first failure. The testnet part takes a few minutes (the protocol suite alone about a minute); the labs take about 8–15 minutes more, including the first Rust build. CI runs `test:core` on Node.js 22.x and 24.x with Rust 1.85.1 and the labs in a separate job; both are blocking. A non-blocking job runs the known-issue lab files (none in v0.5.3).

Expected results for `0.5.3` (Node.js 22 and 24). Last re-checked with `npm run test:all` on Node.js 22.23 and 24.21 with Rust 1.85.1 on 2026-10-08:

| Command | Expected |
|---|---|
| `npm run lint:determinism` | 140 files scanned, 0 violations |
| `npm run check:snapshot-compat` | `format 9, 3 migration step(s) from format 6, fixtures and FORMAT.json consistent` |
| `npm run check:donation` | the donation address decodes as bech32 (checksum OK) and is the only BTC address in the docs |
| `npm run test:protocol` | 199/199 pass, including every golden snapshot fixture and the cryptographic test vectors (about a minute: Poseidon in TypeScript) |
| `npm run test:marketplace` | 210/210 pass (Marketplace, IoT/M2M, HTTP authorization, compatibility shims, height producer and height authority, poisoned-clock helpers, scale, attack battery, Marketplace snapshot format 4 and retention, ledger submit queue, ledger worker host) |
| `npm run test:settlement` | 19/19 pass |
| `npm run test:oracle` | 37/37 pass |
| `npm run test:category` | 23/23 pass |
| `npm run test:poisoned-clock` | 425/425 pass with 0 poisoned-clock violations |
| `npm run smoke:testnet` | `SMOKE OK` |
| `npm run quickstart` | `PASS — local reference testnet` |
| `npm run simulate:20k` | 20,000 settled, 0 errors, `hotExpired: 100`, `valueConserved: true` |
| `npm run test:rust` | 127 pass: uep-21-poseidon 7, uep-25-prototype 9, uep-26-spend-circuit 99, uep-23-state-transition 6, uep-24-atomic 6 |
| `npm run build:uep-zk` | `uep-core/target/release/uep-zk` built from source |
| `npm run test:lab` | 116 files, 546 tests pass, 0 failures; no known-issue files (the list is empty) |
| `npm run test:lab:known` | the known-issue files; the list is empty in v0.5.3, so it runs no files (non-blocking CI job) |
| `npm install --no-save --no-package-lock typescript@5.9.3 @types/node@22 && npx tsc --noEmit -p .` | 0 type errors (blocking CI job; the type checker is installed for that job only, not a package dependency) |

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
