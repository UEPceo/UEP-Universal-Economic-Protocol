# INTEGRATION TASK — three incoming module packages

You are integrating three self-contained packages, already committed under `incoming/`,
into this repository so that they work operationally end to end.

```
incoming/uep-adapted-modules-v2/   swap, relay, dispute, drip over HOLDs (+ its own foundations in src/uep/)
incoming/uep-settlement/           @uep/settlement engine (types, canonical, reference-ledger, engine, batch)
incoming/uep-oracle-layer/         oracle aggregator, verifier, registry, risk-policy, mock
```

## Ground rules

- Work only on this branch / PR. Never touch `main` directly.
- Do not modify `src/lab/`, `uep-core/`, or any existing test's expectations. Do not weaken or delete tests.
- No new runtime dependencies. No TypeScript version bump (`incoming/uep-settlement/package.json`
  asks for `typescript ^7.0.2`; ignore it and use the repo's version).
- Follow the repo's conventions: `.ts` import specifiers, Node >= 22.6 with strip-types, root `tsconfig.json`,
  root `package.json` scripts. The incoming packages must NOT keep their own `package.json` / `tsconfig.json`.
- Testnet / reference status only. Do not add production, ZK-ready or throughput claims anywhere.
- If a design decision is ambiguous, choose the safer option (fail closed), document it in the PR
  description, and continue. Do not stop to ask.

## Step 0 — Read and baseline (before changing code)

1. Read: `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/adr/0001-asset-model.md`,
   `docs/THREAT-MODEL.md`, `CONTRIBUTING.md`, `PUBLIC-SECURITY-REMEDIATION-v0.4.6.md`,
   and the README + docs of each incoming package
   (`incoming/*/README.md`, `incoming/uep-adapted-modules-v2/docs/AUDIT-FIXES.md`,
   `incoming/uep-settlement/docs/*`, `incoming/uep-oracle-layer/docs/*`).
2. Run `npm ci && npm test` and record the baseline (expected: protocol 96/96, marketplace + IoT + HTTP 121/121).
3. Run each incoming package's tests in isolation and record the baseline
   (expected: settlement 8, oracle 30, adapted-modules 63).
   - settlement: `node --experimental-strip-types --test tests/*.test.ts`
   - oracle: `node --experimental-strip-types --test tests/oracle.test.ts`
   - adapted-modules: `npm install && npm test` inside its folder
4. Write your plan to `docs/INTEGRATION-PLAN.md` before implementing.

## Known problems you must resolve

**a) The oracle's Poseidon is not Poseidon.**
`incoming/uep-oracle-layer/src/oracle/canonical.ts` → `poseidon2()` is a home-made permutation with invented
constants (despite the docs saying "Poseidon BN254"). Replace it with the repo's real implementation in
`src/core/poseidon.ts` and verify against the vectors in `uep-core/vectors`. Fix every "Poseidon / ZK-ready"
statement in the oracle docs so it is accurate.

**b) Duplicated foundations.**
- adapted-modules ships its own `ids`, `canonical`, `crypto`, `registry`, `ledger`, `treasury`, `fees`, `settlement-index`.
- settlement ships its own `canonical.ts` and `reference-ledger.ts`.
- The repo already has `src/core` (ed25519, spend-key, composite-key, assets, asset-registry, fee, address, poseidon),
  `src/testnet` and `src/marketplace`.
Remove the duplicates and adapt the modules to the repo's primitives. Preserve behavior and test coverage.
Where an incoming primitive does something the repo's does not (e.g. hashlock, ChaCha20, RFC 6962 Merkle, ReplayGuard,
MonotonicClock), keep it as a small module and document why.

**c) Amount types differ.**
adapted-modules uses `number` safe-integers (with BigInt only inside fee math); oracle and settlement use `bigint`.
Follow ADR 0001 and use a single type at every module boundary. Never convert silently; reject unsafe values.

**d) Three overlapping implementations of disputes / fees / payout.**
The Marketplace (v0.4.4 disputes), `incoming/uep-adapted-modules-v2/src/category/dispute.ts`, and the settlement
engine all implement disputes, fee splits and payout. Do not leave parallel implementations. Required target design:
- Marketplace remains the owner of order state and the signed-action flow.
- ONE fee path: protocol fee `max(1, floor(amount*10/10000))` on ledger spends; marketplace fee
  `max(1, floor(amount*300/10000))` on SETTLED only; treasury buckets 40/25/20/15 (ops / risk / dev / distributable).
- The settlement engine is the single payout executor behind the marketplace (replace direct mutation of
  `held` / `accounts` in the marketplace payout path).
- Dispute outcomes stay `RELEASE` / `REFUND_BUYER` / `SPLIT`; timeout default = refund buyer;
  a `RELEASE` default must still run the category guard (v0.4.6 behavior).
- Document each merge decision in the PR description.

**e) Docs overclaim.**
`incoming/uep-settlement` says "production-ready", ">10,000 tx/sec", "zero supply-chain risk", "Mathematical
value conservation"; the oracle README says "11/11 tests" while the suite has 30. Correct or remove unsupported claims.

## Wiring required

1. Marketplace payout → settlement engine (`src/marketplace/marketplace.ts`).
2. IoT category guard → `src/service/iot-m2m.ts` verified telemetry (signed by the machine's registered key).
3. swap / relay / dispute / drip operate on the integrated ledger and treasury (not their own copies).
4. Oracle is used ONLY in policy evaluation (SVC SLA, IoT tariff, dispute evidence, AMM/swap checks).
   It must never be queried in the spend or consensus path, and it never moves funds itself.
5. Drip stays bound to settled work (settlement index written only by swap and relay settlement).
6. Where the HTTP/service API lab exposes these flows, keep it fail-closed (signed actor, roles).

## Invariants that must not regress

- `valueAccounting()` / `capacityAccounting()` conserved at every step and every outcome.
- Every fund-moving action is a signed message; replay protection and monotonic sequences preserved.
- Fail closed on missing/invalid signature, stale oracle quote, unknown asset, unregistered key.
- No native token. Asset ids namespaced `<namespace>/<symbol>`.
- Dispute timeout default refunds the buyer; unverified IoT delivery is refunded, not paid.

## Tests and CI

- Move incoming tests into the repo's test layout (co-located `*.test.ts` or the repo's existing pattern).
- Add integration tests covering: order → hold → delivery → dispute/settle → fee split → treasury → drip, with value
  conserved after each step; IoT order with and without verified telemetry; swap and relay happy path + fraud/slash;
  oracle stale quote, replay, source pause and circuit breaker; oracle evidence used in an SVC SLA settlement.
- Add scripts `test:settlement`, `test:oracle`, `test:category` to `package.json` and include them in `test:all`.
  Update `.github/workflows/ci.yml` if required. CI must stay green on Node 22.x and 24.x.
- After integration, delete `incoming/` (its content must live in the proper `src/` locations).

## Documentation

Update `README.md` (use the Implemented (testnet) / Experimental (lab) status labels), `CHANGELOG.md`,
`docs/API.md`, `docs/ARCHITECTURE.md` and `docs/THREAT-MODEL.md`. Keep the incoming audit notes
(`AUDIT-FIXES.md`, `AUDIT-REPORT.md`) under `docs/` with accurate scope statements and list residual limits
(SHA-256 vs Poseidon in adapted-modules, in-process isolation, caller-supplied clock, no arbiter appeal/staking).

## Acceptance criteria

1. `npm ci && npm run test:all` passes on Node 22 and 24, with all baseline tests still passing.
2. No duplicated primitive remains; `incoming/` is removed.
3. No stubs, TODOs, `any` shortcuts or commented-out code in the integrated modules.
4. The oracle uses the repo's real Poseidon.
5. The PR description lists: files moved, duplicates removed, every design decision from (d), and remaining limitations.
