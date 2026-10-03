# ADR 0002: Deterministic transitions, height-based time and evidence caps

- Status: accepted (v0.5.0). Rules 1, 2 and 6 below are implemented. Conjunction handling, attester selection and payment, and the default outcome when evidence is missing are open (see the end of this ADR).
- Scope: every state transition of the core, the single-node testnet ledger, the Marketplace (including `settle()`, `deliver()`, settlement guards and category validators) and the IoT/M2M service.
- Code: `src/core/height.ts`, `src/core/domain-profiles.ts`, `src/marketplace/evidence.ts`, `scripts/check-deterministic-transitions.mjs`. Tests in `src/core/height.test.ts`, `src/core/deterministic-transitions.test.ts`, `src/testnet/ledger-height.test.ts`, `src/marketplace/domain-windows.test.ts`, `src/marketplace/evidence-caps.test.ts` and `src/service/iot-mars-delay.test.ts`.

UEP does not depend on external services. If a public API (ephemerides, space weather, orbital data) is down or wrong, every node still computes the same next state from the same inputs. External data can enter the state only as evidence that was produced outside the state machine.

## Rule 1: no external calls and no wall clock inside a transition

A transition is a function of the previous state and the inputs of the transition, nothing else.

- **No external calls.** Transition code never calls `fetch`, opens an HTTP, HTTPS, TCP, UDP, TLS or DNS connection, starts a process or a worker, or reads files that hold live data. Adapters that read external sources run outside the state machine. Their output enters the state only as an evidence statement (rule 6).
- **No wall clock.** Transition code never reads `Date.now()`, `new Date()`, `Date()`, `performance.now()` or `process.hrtime`, and does not use timers.
- **Time is block height.** Every deadline, window and expiry is a block height of the ledger the contract settles against. The header timestamp is not used, because the block proposer chooses it.
  - The single-node testnet ledger exposes `height` (starts at 0, part of the snapshot) and `advanceHeight(blocks = 1)`. Only the operator of the node advances it. It never goes backwards.
  - The Marketplace takes a height source (`height: () => ledger.height`). Without one it keeps a local counter at 0, advanced only by `advanceHeight()`. Nothing expires until the height moves.
  - The IoT/M2M service and the paymaster use the Marketplace clock.
  - Durations are written in heights. The nominal conversion uses the 5 s reference block time (`REFERENCE_BLOCK_TIME_MS`, `HEIGHTS_PER_DAY = 17_280`), rounded up.
- **Test-only clock.** Tests and experiments written before v0.5.0 may inject a millisecond counter (`now: () => number`). It is never a real clock, it is marked deprecated, and it cannot be combined with a height source (`CLOCK_CONFIG_CONFLICT`). In that mode the same windows are expressed in ms (heights × 5,000).
- **Validators and guards.** Category validators, delivery validators and settlement guards run inside `settle()` and `deliver()`. They must be pure functions of their arguments. If one throws, the transition fails for every node in the same way. A hook supplied at run time cannot be checked statically, so this is a requirement on whoever registers it.

### Enforcement

`npm run lint:determinism` (`scripts/check-deterministic-transitions.mjs`) runs first in `npm run test:all` and as its own CI step. It scans `src/core`, `src/testnet`, `src/marketplace` and `src/network` (including their tests), plus the IoT/M2M service files `src/service/iot-m2m.ts`, `iot-m2m-codec.ts`, `iot-testkit.ts` and `content-hash.ts`. Comments and string literals are ignored.

It fails on `fetch(`, `Date.now`, `new Date(`, `Date()`, `performance.now`, `process.hrtime`, `setTimeout` / `setInterval` / `setImmediate`, and on imports of `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `fs`, `child_process`, `worker_threads`, `perf_hooks`, `readline` and `inspector` (with or without the `node:` prefix, static or dynamic).

Allowlist (each entry names a file, a rule and a justification; an entry that no longer matches anything fails the check):

| File | Rule | Justification |
|---|---|---|
| `src/marketplace/listing-index.test.ts` | `performance-now` | Test-only timing of the listing index; it measures the test, not a transition. |
| `src/core/poseidon.test.ts` | `net-import` (`node:fs`) | Test-only read of the committed Poseidon reference vectors in the repository; no live data. |

`src/core/deterministic-transitions.test.ts` checks that the repository is clean and that an injected `Date.now()` in transition code is reported.

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
- **Per attester set.** The Marketplace config lists the attester sets (`evidence.attesterSets`: id, k, n and a cap per asset). The open value (reserved or funded, not yet settled, refunded or expired) of all orders bound to one set may not exceed its cap for that asset. An asset without a cap is refused.
- **Checks.** `reserve()` checks both caps before any value moves (`EVIDENCE_CONTRACT_CAP_EXCEEDED`, `EVIDENCE_ATTESTER_SET_CAP_EXCEEDED`). Settlement checks the per-contract cap again before releasing. The open value is released exactly once when the order closes.
- **Default.** No attester sets, so no listing is bound to evidence. Listings without `evidencePolicy` behave as before and are not capped.

The checks are deterministic and use only state. The evidence records (hash, type, external reference, signatures) are phase 2.3 of the roadmap. The `EvidenceStatement` type fixes their shape so that phase can use these caps unchanged.

## Consequences

- Replicas that replay the same inputs reach the same state whether or not external services are reachable.
- Real time between two heights depends on the block rate. Faster blocks than the reference shorten every window in real time. A minimum block spacing is an open item for the multi-node phase.
- Snapshot format 7 adds the ledger height. `lastReconcileAt` and transaction `createdAt` are heights.

## Open items

- Locks that cross a solar conjunction: allow, forbid, or apply a pre-agreed outcome (deferred to phase 2.3).
- Who can be an attester and how they are paid without a token (deferred to phase 2.3).
- Default outcome per category when evidence does not arrive. This depends on the arbiter decision (D-5). Today the Marketplace refunds the buyer when the provider does not deliver.
- Minimum block spacing, so that the real duration of a window has a lower bound.
- The paymaster quote TTL and the read authorization TTL carry no domain delay.
