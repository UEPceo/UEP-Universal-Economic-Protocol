# Reproducibility Guide — 0.5.80

This guide distinguishes commands from verified outcomes. Test counts are not carried forward from older releases: record results from the exact tree being assessed.

## Environment

- Node.js 22.6 or newer for the TypeScript test runner; the remediation run was performed on Node.js 22.16.0.
- Rust 1.85.x and Cargo for `npm run test:rust` and the ZK research lab build.
- A clean checkout and `npm ci` are recommended. The lab build may need network access to download Rust crates.

## Core validation

```bash
npm ci
npm run check:version
npm run lint:determinism
npm run check:snapshot-compat
npm run test:consensus
npm test
npm run test:poisoned-clock
npm run smoke:testnet
npm run quickstart
npm run simulate:20k
npm run test:rust
npm run build:uep-zk
npm run test:lab
```

`npm test` runs protocol, Marketplace, settlement, Oracle and category suites. `npm run test:consensus` runs the multi-node harness tests. `npm run test:all` wraps the broader core, Rust/ZK build and lab validation; it stops on the first failure.

## Results verified for this remediation bundle

- `npm run test:consensus`: **44/44 passed** on Node.js 22.16.0 after the HTTP test fixtures were corrected.
- `npm run test:protocol`: **214/214 passed** on Node.js 22.16.0.
- `npm run test:settlement`: **20/20 passed**.
- `npm run test:oracle`: **38/38 passed**.
- `npm run test:category`: **24/24 passed**.
- `npm run test:marketplace`: **220/220 passed** across 14 suites on Node.js 22.16.0.
- `npm test`: **516/516 passed** across all five configured suites.
- `npm run test:poisoned-clock` and `npm run simulate:20k` did not finish within the available execution windows; neither result is counted as pass or confirmed failure.
- `npm run test:all`, Node.js 24.x, Rust suites and ZK labs have not been certified by this remediation run.

Do not describe unexecuted or timed-out suites as passing. Re-run them in CI or an environment with adequate time and preserve the raw logs.

## Testnet scope and limitations

The current consensus code is a multi-node engineering harness, not production consensus. In particular:

- The peer set and threshold are configured statically; this is not a complete Byzantine fault-tolerant consensus protocol with view change.
- Catch-up currently trusts a single pinned peer to supply a snapshot. A pinned key is a trust anchor, not a quorum certificate for the snapshot's history.
- The peer `/propose` path exercises the quorum harness, but the local economic API can accept transactions without the peer quorum. Local acceptance must not be described as network finality.
- Local simulation results are not public-network TPS or capacity claims.
- Experimental Groth16/ZK lab code is not a production privacy or validity guarantee.

## Record a reproducible result

Record the commit/archive hash, Node.js and Rust versions, OS, exact command, exit code, duration and raw output. Do not include secrets, private keys, `.env` files or live account data.
