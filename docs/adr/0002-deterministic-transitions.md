# ADR 0002: Deterministic transitions, height-based time and evidence caps

- Status: accepted (v0.5.0). Rules 1, 2 and 6 below are implemented. Conjunction handling, attester selection and payment, and the default outcome when evidence is missing are open (see the end of this ADR).
- Scope: every state transition of the core, the single-node testnet ledger, the Marketplace (including `settle()`, `deliver()`, settlement guards and category validators) and the IoT/M2M service.
- Code: `src/core/height.ts`, `src/core/domain-profiles.ts`, `src/marketplace/evidence.ts`, `src/service/height-producer.ts`, `scripts/check-deterministic-transitions.mjs`, `scripts/poisoned-clock.mjs`. Tests in `src/core/height.test.ts`, `src/core/deterministic-transitions.test.ts`, `src/testnet/ledger-height.test.ts`, `src/marketplace/domain-windows.test.ts`, `src/marketplace/evidence-caps.test.ts`, `src/service/iot-mars-delay.test.ts`, `src/service/height-producer.test.ts` and `src/service/poisoned-clock.test.ts`.

UEP does not depend on external services. If a public API (ephemerides, space weather, orbital data) is down or wrong, every node still computes the same next state from the same inputs. External data can enter the state only as evidence that was produced outside the state machine.

## Rule 1: no external calls and no wall clock inside a transition

A transition is a function of the previous state and the inputs of the transition, nothing else.

- **No external calls.** Transition code never calls `fetch`, opens an HTTP, HTTPS, TCP, UDP, TLS or DNS connection, starts a process or a worker, or reads files that hold live data. Adapters that read external sources run outside the state machine. Their output enters the state only as an evidence statement (rule 6).
- **No wall clock and no randomness.** Transition code never reads `Date.now()`, `new Date()`, `Date()`, `performance.now()`, `process.hrtime` or `process.uptime`, does not use timers or `queueMicrotask`, and does not draw random values (`Math.random`, `crypto.randomUUID`, `randomBytes`, `getRandomValues`, key generation).
- **Time is block height.** Every deadline, window and expiry is a block height of the ledger the contract settles against. The header timestamp is not used, because the block proposer chooses it.
  - The single-node testnet ledger exposes `height` (starts at 0, part of the snapshot) and `advanceHeight(blocks = 1)`. It never goes backwards.
  - **Height producer.** On the single-node testnet the height is advanced by `HeightProducer` (`src/service/height-producer.ts`), which runs outside the transitions and is the only component that reads the wall clock. It seals one block per `REFERENCE_BLOCK_TIME_MS` (5 s) of real time and catches up `n` blocks only when `n × 5 s` have really passed since it was anchored. A clock that goes backwards seals nothing; a height advanced by someone else is not added to (the producer waits until real time catches up). `blockTimeMs` below the minimum block spacing (`MIN_BLOCK_SPACING_MS = 5_000`) is refused (`HEIGHT_PRODUCER_BLOCK_SPACING`). The smoke test, the quickstart, the 20k simulation and the HTTP API (`listenUepHttpApi({ heightProducer })`) run with it.
  - The Marketplace takes a height source (`height: () => ledger.height`). Without one it fails closed (`HEIGHT_SOURCE_REQUIRED`), so a forgotten source cannot silently freeze every expiry. A local counter that only `advanceHeight()` moves is available to tests with the explicit `testOnlyLocalHeight: true`.
  - The paymaster has the same rule. The IoT/M2M service uses the Marketplace clock.
  - After the ledger is restored to a lower height (rollback), a Marketplace bound to it throws `HEIGHT_REGRESSED` on its next transition. The Marketplace state is not part of the ledger snapshot, so the recovery is to rebuild the Marketplace for the restored ledger (a new instance bound to the same height source); its windows then count from the restored height.
  - The IoT/M2M service and the paymaster use the Marketplace clock.
  - Durations are written in heights. The nominal conversion uses the 5 s reference block time (`REFERENCE_BLOCK_TIME_MS`, `HEIGHTS_PER_DAY = 17_280`), rounded up. The reference block time is recorded in the network profile (`TESTNET.referenceBlockTimeMs`) and in every listing's and order's `windows.referenceBlockTimeMs`.
- **Test-only clock.** Tests and experiments written before v0.5.0 may inject a millisecond counter, named `testOnlyNowMs: () => number` (the old name `now` is a deprecated alias). It is never a real clock and it cannot be combined with a height source or with `testOnlyLocalHeight` (`CLOCK_CONFIG_CONFLICT`). In that mode the same windows are expressed in ms (heights × 5,000). The ms mode is deprecated and will be removed in the next minor version (0.6.0). Other legacy inputs (`*Ms` options, Unix-ms values, old asset ids) are converted by deprecated shims outside the transitions; see ADR 0003 and `docs/COMPATIBILITY.md`.
- **Validators and guards.** Category validators, delivery validators and settlement guards run inside `settle()` and `deliver()`. They must be pure functions of their arguments. If one throws, the transition fails for every node in the same way. A hook supplied at run time cannot be checked statically, so this is a requirement on whoever registers it. The poisoned-clock run below checks it by execution for the hooks in the repository. Hooks are attached with `attachCategoryService()` before the category has any listing or order (`CATEGORY_SERVICE_IN_USE` otherwise), so they cannot change the terms of existing contracts.

### Enforcement

**Static lint.** `npm run lint:determinism` (`scripts/check-deterministic-transitions.mjs`) runs first in `npm run test:all` and as its own CI step. It scans `src/core`, `src/testnet`, `src/marketplace` and `src/network` (including their tests), plus the IoT/M2M service files `src/service/iot-m2m.ts`, `iot-m2m-codec.ts`, `iot-testkit.ts` and `content-hash.ts`. Comments and string literals are ignored.

It fails on:

- clocks: `Date.now`, `new Date(`, `Date()`, any other reference to `Date` (aliases such as `const D = Date`), `performance` (any use), `process.hrtime`, `process.uptime`, `process.env`, `process.getBuiltinModule`, `process.binding` and `process[...]`, and `Intl`;
- timers: `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`;
- network and loaders: `fetch` (call or reference), `XMLHttpRequest`, `WebSocket`, `EventSource`, `createRequire`, `globalThis` / `global` / `self` / `window` with `[...]` or with a clock, network or randomness member (`globalThis.fetch`, `globalThis['fetch']`, `globalThis.Date`);
- randomness: `Math.random`, `Math[...]`, `randomBytes`, `randomUUID`, `randomInt`, `randomFill`, `getRandomValues`, `generateKeyPair(Sync)`, `generateKey(Sync)`, `generatePrime`;
- dynamic code: `eval(`, `Function(`, `new Function`, and `import()` / `require()` with a computed specifier;
- imports of `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `fs`, `child_process`, `worker_threads`, `perf_hooks`, `readline`, `inspector`, `timers`, `timers/promises`, `os`, `module`, `vm`, `cluster`, `repl` and `undici` (with or without the `node:` prefix, static or dynamic);
- import closure: a non-test scanned file may import only scanned files (type-only imports excepted), so a clock read cannot hide in a helper outside the scanned paths.

Allowlist (each entry names a file, a rule, optionally the lines it covers, and a justification; an entry that no longer matches anything fails the check):

| File | Rule | Lines | Justification |
|---|---|---|---|
| `src/marketplace/listing-index.test.ts` | `performance-now` | all | Test-only timing of the listing index; it measures the test, not a transition. |
| `src/core/poseidon.test.ts` | `net-import` (`node:fs`) | all | Test-only read of the committed Poseidon reference vectors in the repository; no live data. |
| `src/testnet/snapshot-fixtures.test.ts` | `net-import` (`node:fs`) | all | Test-only read of the committed golden snapshot fixtures (ADR 0003); no live data. |
| `src/core/ed25519.ts` | `randomness` | the `node:crypto` import (line 10) and `generateKeyPairSync("ed25519")` (line 18) | `generateEd25519KeyPair()` creates a key for an identity, a node or a test. Key owners and tooling call it, never a transition; checked by execution in the poisoned-clock run. |
| `src/service/iot-m2m.ts` | `randomness` | the `node:crypto` import (line 32) and `generateKeyPairSync("ed25519")` in `createIoTMachineIdentity()` (line 182) | `createIoTMachineIdentity()` creates a machine key on the machine side; no IoT transition calls it; checked by execution in the poisoned-clock run. |

A line-scoped entry does not cover any other randomness call in the same file. `src/core/deterministic-transitions.test.ts` checks that the repository is clean, that every evasion above is reported (aliases, the global object, randomness, timers, loaders, computed imports), that an injected `Date.now()` and an import of a helper outside the scanned paths fail the check, and that the allowlist stays this small.

**Poisoned clock (execution check).** A regular-expression lint catches accidents, not every way of reaching a clock. `scripts/poisoned-clock.mjs` therefore wraps the transitions of `UepLedger` (except the client-side `prepareSpend` / `preparePayment`), `DigitalServicesMarketplace`, `MarketplacePaymaster` (except `quote`) and `IoTM2MService`, and replaces `Date`, `performance`, `process.hrtime` / `uptime`, the timers, `fetch`, the `http` / `https` / `net` / `dns` entry points, `Math.random` and the `crypto` random and key-generation functions with versions that throw `POISONED_CLOCK` and record a violation while a transition runs (outside a transition they work normally). `src/service/poisoned-clock.test.ts` runs a full ledger, Marketplace and IoT flow with no violation and shows that clock, network and randomness reads in a settlement guard are caught, including through aliases. `npm run test:poisoned-clock` (part of `test:all`) runs the testnet, Marketplace, IoT, compatibility, HTTP and height-producer suites under the same poison as a preload; the run fails if any transition touched a poisoned API, even when the transition caught the error.

## Rule 2: fixed delay windows per domain profile

A listing declares the domain profile of its counterparties when it is published: `EARTH` (default), `MOON` or `MARS`. The profile is part of the signed listing terms when it is not `EARTH`, it is copied to every order, and it cannot change afterwards. Each profile adds a fixed delay Δ to every window in which a counterparty message has to cross the link:

    Δ = ceil(5/4 × 2 × one-way light time (worst case) / 5 s)

That is one round trip (request out, report back) with a 25% margin. Δ is computed ex ante and never read from a live source.

| Profile | Worst-case one-way light time | Δ (heights) | Δ (nominal) |
|---|---|---|---|
| EARTH | 0 | 0 | 0 |
| MOON | 1.357 s (Earth–Moon distance at apogee, about 406,700 km) | 1 | 5 s |
| MARS | 1,203.6 s = 20.06 min (maximum between 2026-10-03 and 2028-12-03, minimum 338.3 s) | 602 | 50.17 min |

The Mars figures were computed offline from the public JPL DE442s planetary ephemeris kernel. With the margin, the MARS Δ (50.17 min) also exceeds one round trip at the largest possible Earth–Mars distance (about 2.68 AU, about 22.3 min one way).

Windows (base windows are the previous wall-clock defaults converted to heights; each is configurable on the Marketplace in heights):

| Window | EARTH | MOON | MARS |
|---|---|---|---|
| Reservation TTL | 120 (10 min) | 121 | 722 (60.2 min) |
| Cancellation grace | 24 (2 min) | 25 | 626 (52.2 min) |
| Delivery dispute window | 17,280 (24 h) | 17,281 | 17,882 (24 h 50 min) |
| Dispute resolution window | 120,960 (7 d) | 120,961 | 121,562 (7 d 50 min) |
| IoT telemetry maximum age | 60 (5 min) | 61 | 662 (55.2 min) |
| IoT telemetry future skew | 6 (30 s) | 6 | 6 |

Marketplace-wide windows that do not depend on the counterparty's domain: read and list authorization TTL 60 heights (5 min), listing rate-limit window 720 heights (1 h), paymaster quote TTL 120 heights (10 min).

With these windows, IoT telemetry from Mars that arrives 338.3 s or 1,203.6 s after it was observed is verified and settled with the default configuration (`src/service/iot-mars-delay.test.ts`). The same telemetry is still rejected by an `EARTH` listing.

**Not covered.** The windows cover light time only. A solar conjunction (about 46 days around March 2028 with the Sun–Earth–Mars angle below 5 degrees, roughly 795,000 heights) or a gap in the contact plan is outside every MARS window. Such orders expire as on Earth.

## Rule 6: evidence trust model and value caps

Evidence certifies only that **source X published data D at height H, signed by k of n attesters**. It never certifies that D is true. See `docs/EVIDENCE.md`.

Because a wrong source makes every honest attester sign the same wrong data, the value evidence can move is capped:

- **Per contract.** A listing bound to evidence declares `evidencePolicy: { attesterSetId, maxValuePerContract }` at publication (signed, immutable). Each order may lock at most `maxValuePerContract` (gross amount + gas, in the listing asset). There is no default: the listing has to declare it, and it may not exceed the attester set's cap.
- **Per attester set.** The Marketplace config lists the attester sets (`evidence.attesterSets`: id, `sourceId`, the attesters' Ed25519 public keys, k, n and a cap per asset). Only **funded** value counts: the gross amount + gas of orders that are HELD, DELIVERED or DISPUTED. Unfunded reservations (ACCEPTED) do not take any of the cap, so they cannot fill it at no cost. An asset without a cap is refused.
- **No duplicate sets.** Two sets that observe the same `sourceId` with any attester key in common are rejected (`EVIDENCE_ATTESTER_SET_DUPLICATE`), so the same attesters cannot multiply a cap by registering the same source under several ids. A cap per source and per attester across sets is phase 2.3.
- **Checks.** `reserve()` checks the per-contract cap and, without taking anything, whether the set still has room (fail early). `fundOrder()` takes the set cap before any value moves (`EVIDENCE_ATTESTER_SET_CAP_EXCEEDED`). Settlement checks the per-contract cap again before releasing. The funded value is released exactly once when the order closes.
- **Read-only view.** `marketplace.evidenceCaps` exposes only `openValue(setId, asset)` and `attesterSet(setId)`; the instance that locks and releases is private.
- **Default.** No attester sets, so no listing is bound to evidence. Listings without `evidencePolicy` behave as before and are not capped.

The checks are deterministic and use only state. The evidence records (hash, type, external reference, signatures) are phase 2.3 of the roadmap. The `EvidenceStatement` type fixes their shape so that phase can use these caps unchanged.

## Consequences

- Replicas that replay the same inputs reach the same state whether or not external services are reachable.
- Real time between two heights depends on the block rate. Faster blocks than the reference shorten every window in real time; slower blocks only lengthen them. Safe range for the published windows: blocks of at least 3.34 s keep the worst-case Earth–Mars round trip (241 + 241 heights out and back, plus up to 240 heights of waiting) inside the MARS reservation window; at least 1.82 s keep the one-way telemetry inside the MARS telemetry age. The height producer enforces at least 5 s.
- **Trust in the single-node operator.** On the single-node testnet the operator is the time authority. It can advance the height faster than real time (for example `ledger.advanceHeight(17_280)` lets a provider settle without the buyer's 24 h dispute window, and makes a MARS reservation or a 7-day dispute window expire at once). The height producer never does this, but the operator controls the process, as it can already censor or reorder transactions. This is an explicit trust assumption of the single-node testnet (`docs/THREAT-MODEL.md`). For several nodes a block-validation rule with a minimum spacing between blocks is required before heights can be trusted across operators.
- Snapshot format 7 adds the ledger height. `lastReconcileAt` and transaction `createdAt` are heights. Format 6 snapshots are migrated to format 7 (height 0; ADR 0003).

## Open items

- Locks that cross a solar conjunction: allow, forbid, or apply a pre-agreed outcome (deferred to phase 2.3).
- Who can be an attester and how they are paid without a token (deferred to phase 2.3).
- Default outcome per category when evidence does not arrive. This depends on the arbiter decision (D-5). Today the Marketplace refunds the buyer when the provider does not deliver.
- Minimum block spacing across nodes: a block-validation rule for the multi-node phase (the single-node producer already enforces 5 s).
- The paymaster quote TTL and the read authorization TTL carry no domain delay.
