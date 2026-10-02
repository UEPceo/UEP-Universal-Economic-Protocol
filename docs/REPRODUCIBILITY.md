# Reproducibility Guide

## Environment

Use Node.js 22.6+.

The repository is intentionally dependency-light and uses Node's built-in
TypeScript type stripping for the reference test runner.

## Clean run

```bash
npm ci
npm test
```

Expected results at `0.4.6-public-iot-m2m` (Node.js 22 and 24):

| Command | Expected |
|---|---|
| `npm run test:protocol` | 67/67 pass |
| `npm run test:marketplace` | 94/94 pass (includes the 23 IoT/M2M tests) |
| `npm run test:scale` | 3/3 pass |
| `npm run test:iot` | 23/23 pass |
| `npm run smoke:testnet` | `SMOKE OK` |
| `npm run quickstart` | `PASS — local reference testnet` |
| `npm run simulate:20k` | 20,000 settled, 0 errors, `valueConserved: true` |

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
