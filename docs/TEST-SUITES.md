# Test suites and coverage limits (0.5.81)

These suites are evidence for specific claims. They do not show that a deployed distributed network is safe.

## Classes

| Class | Command | CI | Blocking |
|---|---|---|---|
| Critical security | `npm run test:security` | job `Node 22.x` / `Node 24.x`, named step | yes |
| Mandatory core | `npm run test:core` (lint, snapshot compat, protocol, marketplace, settlement, oracle, category, consensus, node, poisoned clock, smoke, quickstart, 20k simulation, Rust) | `Node 22.x`, `Node 24.x` | yes |
| Seeded property / fuzz / multi-process fault | `npm run test:property:full` | `Seeded property and fault runs` | yes |
| Integration labs | `npm run test:lab` (all `src/lab` and service labs except known issues) | `Labs (blocking, known issues excluded)` | yes |
| Experimental / known issues | `npm run test:lab:known` (files in `scripts/lab-known-issues.json`) | `Labs with known issues` | no |
| Type check | `tsc --noEmit` | `Type check` | no |

The critical security set: `certified-commit`, `bft-binding`, `snapshot-rules`, `registry-binding`, `transport-0581`, `order-state-machine`, `amount`. The ZK binding test (`src/lab/zk-binding-0581.test.ts`) needs the `uep-zk` DEV binary and runs in the blocking labs job.

## Seeds and run records

`scripts/run-seeded.mjs` runs each seeded suite over `20261015,1,7,42,2026,31337` (override with `--seeds`). It writes `artifacts/test-runs/<commit>-node<major>.json` with the seed list, Node version, platform, CPU count, commit, per-run pass/fail counts, first failure lines and a reproduce command. CI uploads it as the `seeded-runs` artifact. To reproduce one run: `UEP_MKT_SEED=<seed> node --experimental-strip-types --test src/marketplace/order-state-machine.test.ts` (likewise `UEP_NUM_SEED`, `UEP_BFT_FAULT_SEED`).

## Pending failures (0.5.81)

- `scripts/lab-known-issues.json` is empty: no lab is excluded from the blocking job.
- `typecheck` is non-blocking and reports remaining type errors; it is not a gate.

## Coverage limits (0.5.81)

- Multi-process BFT runs are 4 processes on one host over loopback with a fault proxy. No multi-host or WAN runs.
- No formal model checking of the BFT protocol; the rules are written (docs/CONSENSUS-BFT-ROADMAP.md) and tested by example and seeded runs.
- Fuzzing is seeded random input generation inside the test runner (amount parser, marketplace operations, network faults), not coverage-guided fuzzing.
- ZK: DEV Groth16 keys only, no ceremony; change outputs are bound only through `new_state_root`.
- No line or branch coverage figure is published; Node's coverage is not run in CI.
