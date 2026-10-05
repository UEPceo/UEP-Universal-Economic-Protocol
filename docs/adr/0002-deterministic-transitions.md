# ADR 0002: Deterministic transitions, height-based time and evidence caps

- Status: accepted (v0.5.1). Rules 1, 2 and 6 below are implemented. Conjunction handling, attester selection and payment, and the default outcome when evidence is missing are open (see the end of this ADR).
- Scope: every state transition of the core, the single-node testnet ledger, the Marketplace (including `settle()`, `deliver()`, settlement guards and category validators) and the IoT/M2M service.
- Code: `src/core/height.ts`, `src/core/domain-profiles.ts`, `src/core/test-only.ts`, `src/core/ed25519-point.ts`, `src/marketplace/evidence.ts`, `src/service/height-producer.ts`, `scripts/check-deterministic-transitions.mjs`, `scripts/poisoned-clock.mjs`. Tests in `src/core/height.test.ts`, `src/core/deterministic-transitions.test.ts`, `src/testnet/ledger-height.test.ts`, `src/marketplace/domain-windows.test.ts`, `src/marketplace/evidence-caps.test.ts`, `src/service/iot-mars-delay.test.ts`, `src/service/height-producer.test.ts` and `src/service/poisoned-clock.test.ts`.

UEP does not depend on external services. If a public API (ephemerides, space weather, orbital data) is down or wrong, every node still computes the same next state from the same inputs. External data can enter the state only as evidence that was produced outside the state machine.

## Rule 1: no external calls and no wall clock inside a transition

A transition is a function of the previous state and the inputs of the transition, nothing else.

- **No external calls.** Transition code never calls `fetch`, opens an HTTP, HTTPS, TCP, UDP, TLS or DNS connection, starts a process or a worker, or reads files that hold live data. Adapters that read external sources run outside the state machine. Their output enters the state only as an evidence statement (rule 6).
- **No wall clock and no randomness.** Transition code never reads `Date.now()`, `new Date()`, `Date()`, `performance.now()`, `process.hrtime` or `process.uptime`, does not use timers or `queueMicrotask`, and does not draw random values (`Math.random`, `crypto.randomUUID`, `randomBytes`, `getRandomValues`, key generation).
- **Time is block height.** Every deadline, window and expiry is a block height of the ledger the contract settles against. The header timestamp is not used, because the block proposer chooses it.
  - The single-node testnet ledger exposes `height` (starts at 0, part of the snapshot) and `advanceHeight(blocks = 1)`. Outside test mode one call seals at most `MAX_BLOCKS_PER_TICK = 12` blocks (`HEIGHT_ADVANCE_CAP`; the test-only `testOnlyUnboundedHeightAdvance` lifts it).
  - **Height producer.** On the single-node testnet the height is advanced by `HeightProducer` (`src/service/height-producer.ts`), which runs outside the transitions. It measures elapsed time with a **monotonic** clock (`performance.now()`), never with the wall clock, and seals one block per `REFERENCE_BLOCK_TIME_MS` (5 s) of monotonic time since it was anchored. A step of the system clock (an NTP correction, a manual change) seals nothing; it is only logged (`wall-clock-jump`, by comparing `Date.now()` with the monotonic clock). An injected clock that goes backwards seals nothing. A height advanced by someone else is not added to: the producer waits until real time catches up, so after an operator fast-forward of `n` blocks the chain stands still for `n × 5 s` (`status().aheadBy` shows the lead). `blockTimeMs` below the minimum block spacing (`MIN_BLOCK_SPACING_MS = 5_000`) is refused (`HEIGHT_PRODUCER_BLOCK_SPACING`). The smoke test, the quickstart, the 20k simulation and the HTTP API run with it; `listenUepHttpApi()` refuses to serve a Marketplace on an injected height source without `heightProducer` (`HEIGHT_PRODUCER_REQUIRED`).
  - **Catch-up cap.** One producer tick seals at most `MAX_BLOCKS_PER_TICK = 12` blocks (1 minute). After a longer gap (a stalled event loop, a suspended process) the rest of the gap is dropped and logged (`catch-up-capped`): the windows freeze for that time instead of expiring at once.
  - **Restart: windows freeze.** The producer's anchor is not persisted and the snapshot carries no time. A restarted node anchors a new producer at the restored height and the current time, so the downtime does not count and nothing is caught up beyond the per-tick cap. **Operator downtime extends every deadline in real time by the length of the downtime and never expires a party** (no reservation, grace or dispute window runs out because the node was down).
  - The Marketplace takes a height source (`height: heightOf(ledger)` or `() => ledger.height`). Without one it fails closed (`HEIGHT_SOURCE_REQUIRED`), so a forgotten source cannot silently freeze every expiry. A local counter that only `advanceHeight()` moves is available to tests with the explicit `testOnlyLocalHeight: true`.
  - The paymaster has the same rule, and a Marketplace refuses a paymaster that reads another height source (`CLOCK_CONFIG_CONFLICT`): the check compares the source itself, not only the unit, so pass the same function (e.g. `const height = heightOf(ledger)`) to both. The IoT/M2M service uses the Marketplace clock.
  - **Restore and rollback.** `UepLedger.restore(snapshot, trust, keys, { replaces, minHeight })` never lowers the height: a snapshot below the replaced ledger's height, below `minHeight` or below the trusted checkpoint's height (checkpoints carry the height) is refused (`INVALID_SNAPSHOT_HEIGHT_REGRESSION`) unless the operator passes `allowHeightRegression: true`. The replaced ledger is retired: its `advanceHeight()` throws `LEDGER_RETIRED`, so a producer still bound to it stops at its next tick; `producer.rebind(restored)` moves the producer to the restored ledger. After a forced rollback, a Marketplace bound to the ledger throws `HEIGHT_REGRESSED` on its next transition. The Marketplace has no snapshot: rebuilding it for the restored ledger **loses its open orders and the value they hold** (there is no Marketplace recovery today), so a rollback is an operator action with that cost.
  - The IoT/M2M service and the paymaster use the Marketplace clock.
  - Durations are written in heights. The nominal conversion uses the 5 s reference block time (`REFERENCE_BLOCK_TIME_MS`, `HEIGHTS_PER_DAY = 17_280`), rounded up. The reference block time is recorded in the network profile (`TESTNET.referenceBlockTimeMs`) and in every listing's and order's `windows.referenceBlockTimeMs`.
- **Test-only options.** Every `testOnly*` option (and the `now` alias) is rejected under `NODE_ENV=production` (`TEST_ONLY_OPTION_IN_PRODUCTION`); boolean flags must be the boolean `true`. Options that come from outside the process (JSON configuration, request bodies) must go through `assertNoTestOnlyOptions()` / `parseUntrustedOptions()` (`src/core/test-only.ts`), which refuse any test-only key at any depth (`TEST_ONLY_OPTION_UNTRUSTED`); an in-process object and a JSON-parsed one look the same at run time, so the boundary that parsed the input has to call it.
- **Test-only clock.** Tests and experiments written before v0.5.0 may inject a millisecond counter, named `testOnlyNowMs: () => number` (the old name `now` is a deprecated alias). It is never a real clock and it cannot be combined with a height source or with `testOnlyLocalHeight` (`CLOCK_CONFIG_CONFLICT`). In that mode the same windows are expressed in ms (heights × 5,000). The ms mode is deprecated and will be removed in the next minor version (0.6.0). Other legacy inputs (`*Ms` options, Unix-ms values, old asset ids) are converted by deprecated shims outside the transitions; see ADR 0003 and `docs/COMPATIBILITY.md`.
- **Validators and guards.** Category validators, delivery validators and settlement guards run inside `settle()` and `deliver()`. They must be pure functions of their arguments. If one throws, the transition fails for every node in the same way. A hook supplied at run time cannot be checked statically, so this is a requirement on whoever registers it. The poisoned-clock run below checks it by execution for the hooks in the repository. Hooks are attached with `attachCategoryService()` before the category has any listing or order (`CATEGORY_SERVICE_IN_USE` otherwise), and the Marketplace keeps a frozen copy of them, so neither a later attach nor a later change to the caller's hook object can change the terms of existing contracts. Listings are not extensible after publication, and an order's `windows` are frozen at `reserve()`.

### Enforcement

**Both checks are guards, not a sandbox.** The lint reads source text with regular expressions and the poisoned clock patches known entry points at run time. Together they catch accidents and every evasion we know of (listed below and tested), not a determined contributor: a reference to an original function captured before the poison is installed, a native addon, or an API neither list names would pass. Review of transition code stays necessary.

**Static lint.** `npm run lint:determinism` (`scripts/check-deterministic-transitions.mjs`) runs first in `npm run test:all` and as its own CI step. It scans `src/core`, `src/testnet`, `src/marketplace` and `src/network` (including their tests), plus the IoT/M2M service files `src/service/iot-m2m.ts`, `iot-m2m-codec.ts`, `iot-testkit.ts` and `content-hash.ts`. Comments and string literals are ignored.

It fails on:

- clocks: `Date.now`, `new Date(`, `Date()`, any other reference to `Date` (aliases such as `const D = Date`, `Date(0)`, `Object.getPrototypeOf(Date)`), `performance` (any use, including `timeOrigin`), `process.hrtime`, `process.uptime`, `process.env`, `process.memoryUsage` / `cpuUsage` / `resourceUsage`, `process.getBuiltinModule`, `process.binding` and `process[...]`, and `Intl`;
- scheduling- and GC-dependent APIs: `Atomics.wait`, `WeakRef`, `FinalizationRegistry`;
- timers: `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`;
- network and loaders: `fetch` (call or reference), `XMLHttpRequest`, `WebSocket`, `EventSource`, `createRequire`, `globalThis` / `global` / `self` / `window` with `[...]` or with a clock, network or randomness member (`globalThis.fetch`, `globalThis['fetch']`, `globalThis.Date`);
- randomness: `Math.random`, `Math[...]`, `randomBytes`, `randomUUID`, `randomInt`, `randomFill`, `getRandomValues`, `generateKeyPair(Sync)`, `generateKey(Sync)`, `generatePrime`, `createECDH`, `createDiffieHellman(Group)`, `getDiffieHellman`. Randomized signatures (`crypto.sign` with an ECDSA or RSA-PSS key) cannot be told apart from Ed25519 signing in source text; the poisoned clock catches them at run time;
- dynamic code: `eval(`, `Function(`, `new Function`, and `import()` / `require()` with a computed specifier;
- imports of `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `fs`, `child_process`, `worker_threads`, `perf_hooks`, `readline`, `inspector`, `timers`, `timers/promises`, `os`, `module`, `vm`, `cluster`, `repl` and `undici` (with or without the `node:` prefix, static or dynamic);
- import closure, checked **per statement** (two imports on one line are two statements): a non-test scanned file may import only scanned files and `node:crypto` (type-only imports excepted), so a clock read cannot hide in a helper outside the scanned paths. Non-relative specifiers (npm packages, bare builtins such as `"crypto"`), `file:` URLs, absolute paths, `#subpath` imports and template-literal specifiers are violations; tests may import relative helpers outside the scanned paths but none of these.

Allowlist (each entry names a file, a rule, optionally the lines it covers, and a justification; an entry that no longer matches anything fails the check):

| File | Rule | Lines | Justification |
|---|---|---|---|
| `src/core/test-only.ts` | `process-state` | `process.env.NODE_ENV === "production"` | Configuration-time guard that rejects `testOnly*` options under `NODE_ENV=production`; called from constructors when such an option is passed, never from a transition. |
| `src/testnet/key-derived-accounts.test.ts` | `net-import` (`node:fs`) | all | Test-only read of a committed golden snapshot fixture (v2 account ids); no live data. |
| `src/marketplace/listing-index.test.ts` | `performance-now` | all | Test-only timing of the listing index; it measures the test, not a transition. |
| `src/core/asset-registry.test.ts` | `net-import` (`node:fs`) | all | Test-only read of a committed, frozen v0.5.0 asset registry manifest; no live data. |
| `src/core/poseidon.test.ts` | `net-import` (`node:fs`) | all | Test-only read of the committed Poseidon reference vectors in the repository; no live data. |
| `src/testnet/snapshot-fixtures.test.ts` | `net-import` (`node:fs`) | all | Test-only read of the committed golden snapshot fixtures (ADR 0003); no live data. |
| `src/core/ed25519.ts` | `randomness` | the `node:crypto` import (line 10) and `generateKeyPairSync("ed25519")` (line 18) | `generateEd25519KeyPair()` creates a key for an identity, a node or a test. Key owners and tooling call it, never a transition; checked by execution in the poisoned-clock run. |
| `src/service/iot-m2m.ts` | `randomness` | the `node:crypto` import (line 32) and `generateKeyPairSync("ed25519")` in `createIoTMachineIdentity()` (line 182) | `createIoTMachineIdentity()` creates a machine key on the machine side; no IoT transition calls it; checked by execution in the poisoned-clock run. |

A line-scoped entry does not cover any other call of the same rule in the same file. `src/core/deterministic-transitions.test.ts` checks that the repository is clean, that every evasion above is reported (aliases, the global object, randomness, key agreement, timers, loaders, computed imports, the import-closure variants), that an injected `Date.now()` and an import of a helper outside the scanned paths fail the check, and that the allowlist stays this small.

**Poisoned clock (execution check).** A regular-expression lint catches accidents, not every way of reaching a clock. `scripts/poisoned-clock.mjs` therefore wraps the transitions of `UepLedger` (except the client-side `prepareSpend` / `preparePayment`), `DigitalServicesMarketplace`, `MarketplacePaymaster` (except `quote`) and `IoTM2MService`. While a transition runs, these entry points throw `POISONED_CLOCK` and record a violation (outside a transition they work normally):
- `Date`: `Date.now` (also on the real `Date`, reached through `new Date(0).constructor` or `Date.prototype.constructor`), `new Date()` without arguments and `Date(...)` called as a function with any arguments; `Object.getPrototypeOf(Date)` no longer leads to an unpatched `Date`;
- `performance.now`, `performance.timeOrigin`, `process.hrtime` / `uptime` / `memoryUsage` / `cpuUsage` / `resourceUsage`, `process.env`, `Intl.DateTimeFormat` `format()` / `formatToParts()` without a date;
- timers, also from `node:timers` and `node:timers/promises`, `queueMicrotask` and `Promise.then` (async continuations);
- `fetch` and the `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `fs`, `fs/promises`, `child_process` and `os` entry points;
- `Math.random`, the `crypto` random and key-generation functions, ECDH / Diffie-Hellman, `createSign` and `crypto.sign` with a key type other than Ed25519 / Ed448.

Calls through an alias or a helper in another file reach these patched functions and are caught. A reference to an original function captured before the poison was installed is **not** caught (an alias is caught only when it is taken while the poison is active or points at a patched object), and neither is anything outside the list. `src/service/poisoned-clock.test.ts` runs a full ledger, Marketplace and IoT flow with no violation and shows that each listed read in a settlement guard is caught. `npm run test:poisoned-clock` (part of `test:all`) runs the testnet, Marketplace, IoT, compatibility, HTTP and height-producer suites under the same poison as a preload; the run fails if any transition touched a poisoned API, even when the transition caught the error.

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
- **Per provider inside a set.** One provider's funded open value in a set may not exceed `providerCapBps` of the set cap (optional, default 2,500 = 25%; `EVIDENCE_PROVIDER_CAP_EXCEEDED`). A buyer with capital equal to the set cap who funds orders on its own listing therefore fills its own subcap, not the whole set. A listing whose `maxValuePerContract` exceeds the subcap is refused at publication. Like every per-identity cap, it binds identities and relies on identities being costly.
- **No loss for a system reason.** If `fundOrder()` fails because the set cap or the provider subcap is full, the reservation closes without fault (`CANCELLED`, `closeReason: "EVIDENCE_CAP_FULL"`) and the buyer's deposit is returned; the call still fails with the cap error.
- **One set per attester key (until phase 2.3).** Attester keys are normalized (64 lowercase hex; SPKI DER hex accepted) and must be prime-order Ed25519 points: all-zero, identity, small-order, non-canonical and off-curve keys are refused. Each key may belong to one set only, whatever the `sourceId` (`EVIDENCE_ATTESTER_SET_DUPLICATE`): the same attesters cannot multiply a cap by registering the source again under another id or another spelling of its URL. A cap per source and per attester across sets is phase 2.3.
- **Checks.** `reserve()` checks the per-contract cap and, without taking anything, whether the set and the provider still have room (fail early). `fundOrder()` takes the set cap and the provider subcap before any value moves. Settlement checks the per-contract cap again before releasing. The funded value is released exactly once when the order closes.
- **Read-only view.** `marketplace.evidenceCaps` exposes only `openValue`, `providerOpenValue`, `providerCap` and `attesterSet`; the instance that locks and releases is an ECMAScript private field.
- **Default.** No attester sets, so no listing is bound to evidence. Listings without `evidencePolicy` behave as before and are not capped.

The checks are deterministic and use only state. The evidence records (hash, type, external reference, signatures) are phase 2.3 of the roadmap. The `EvidenceStatement` type fixes their shape so that phase can use these caps unchanged.

## Consequences

- Replicas that replay the same inputs reach the same state whether or not external services are reachable.
- Real time between two heights depends on the block rate. Faster blocks than the reference shorten every window in real time; slower blocks only lengthen them. Safe range for the published windows: blocks of at least 3.34 s keep the worst-case Earth–Mars round trip (241 + 241 heights out and back, plus up to 240 heights of waiting) inside the MARS reservation window; at least 1.82 s keep the one-way telemetry inside the MARS telemetry age. The height producer enforces at least 5 s.
- **Trust in the single-node operator.** On the single-node testnet the operator is the time authority. It can advance the height faster than real time: `advanceHeight(n)` is bounded to 12 blocks per call, but the operator can call it repeatedly (1,440 calls give the 24 h dispute window), which lets a provider settle without the buyer's dispute window or makes a MARS reservation or a 7-day dispute window expire at once. After such a fast-forward the producer seals nothing until real time catches up, so the chain also stands still for the same time. The height producer never does this, but the operator controls the process, as it can already censor or reorder transactions. This is an explicit trust assumption of the single-node testnet (`docs/THREAT-MODEL.md`). For several nodes a block-validation rule with a minimum spacing between blocks is required before heights can be trusted across operators.
- Snapshot format 7 adds the ledger height. `lastReconcileAt` and transaction `createdAt` are heights. Format 6 snapshots are migrated to format 7 (height 0; ADR 0003).

## Open items

- Locks that cross a solar conjunction: allow, forbid, or apply a pre-agreed outcome (deferred to phase 2.3).
- Who can be an attester and how they are paid without a token (deferred to phase 2.3).
- Default outcome per category when evidence does not arrive. This depends on the open decision about the arbiter. Today the Marketplace refunds the buyer when the provider does not deliver.
- Minimum block spacing across nodes: a block-validation rule for the multi-node phase (the single-node producer already enforces 5 s).
- The paymaster quote TTL and the read authorization TTL carry no domain delay.
