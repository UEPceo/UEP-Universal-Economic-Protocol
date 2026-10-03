# Compatibility policy: snapshots, APIs and deprecations

This page is the compatibility policy of the UEP public testnet code. It says what a release must keep working, how a format or API change is introduced, and what is checked in CI. The reasoning is in [ADR 0003](./adr/0003-compatibility-and-migrations.md).

The policy covers:

- ledger snapshots (`UepLedger.snapshot()`, `restore()`, `restoreChain()`);
- the public TypeScript API (`src/core`, `src/testnet`, `src/marketplace`, `src/service`);
- the HTTP adapter (`/v1/*`) and its headers;
- asset ids.

The labs (`src/lab`, `uep-core`, the research circuits) are experimental and not covered. Their changes are listed in the CHANGELOG.

## 1. Rules

1. **Every snapshot format has a migration.** A snapshot of the previous format restores through a chain of migration steps vN → vN+1 (`src/testnet/snapshot-migrations.ts`). A format can only be dropped, and refused with a stated reason, when no deterministic conversion exists (section 3).
2. **Golden fixtures are required.** Every supported snapshot format has at least one committed golden fixture produced by the release that wrote that format (`src/testnet/fixtures/snapshots/`). Every step lists the fixtures it is tested on.
3. **CI loads every historical fixture.** `src/testnet/snapshot-fixtures.test.ts` restores every fixture on every run, through the migrations, and submits a transaction on the restored ledger. Fixtures of formats that cannot be migrated must be refused with their stated reason.
4. **No format change without a step and a fixture.** `npm run check:snapshot-compat` fails if the snapshot format or the payload shape changes without a migration step, a fixture and an updated lock file (section 4).
5. **Deprecation window.** A deprecated API, option, field, header form or asset id keeps working for at least one minor version after the release that deprecates it. That means until at least the next minor release, for example deprecated in 0.5.x and removed in 0.6.0 at the earliest. While it works it emits a Node.js `DeprecationWarning` with a stable code (section 6). Removal is announced in the CHANGELOG of the release that deprecates it.
6. **Shims stay outside the transitions.** A shim converts a legacy input deterministically, before it reaches the state machine, or at a boundary adapter that already has a clock. Transitions stay clock-free ([ADR 0002](./adr/0002-deterministic-transitions.md), `npm run lint:determinism`).
7. **Versions.** The snapshot `formatVersion` is an integer that changes on every payload change. The HTTP adapter has a semantic version (`UEP_HTTP_API_VERSION`): additive changes bump the minor version and breaking changes the major version, and a breaking change needs the deprecation window of rule 5.

## 2. Snapshot formats

`SNAPSHOT_FORMAT_VERSION = 7`.

| Format | Written by | Restore in this release |
|---|---|---|
| 1, 2 | before v0.4.3 | Refused (`INVALID_SNAPSHOT_VERSION`, reason below) |
| 3 | v0.4.3 | Refused |
| 4 | v0.4.4 | Refused |
| 5 | v0.4.5 – v0.4.7 | Refused; fixture `v5-v0.4.7-9922cdb.json` checks the refusal and its reason |
| 6 | the Poseidon protocol hash release and v0.5.0 (both the pre-release asset ids and the namespaced ids) | **Migrated** 6 → 7; fixtures `v6-main-020e6ce.json` (old asset ids `asset:test:*`) and `v6-v0.5.0-8d774d3.json` |
| 7 | this release | Current; fixture `v7-v0.5.0-evidence-time.json` |

### Restore order

1. Read `formatVersion`. A newer format fails with "newer than this release". A refused format fails with its reason.
2. Check the snapshot **exactly as it was signed**: the hash, the authority signatures (k of n), the chain link and the checkpoint.
3. Apply the migration steps in order (`migrateSnapshotPayload`). A step that rejects its input fails with `INVALID_SNAPSHOT_MIGRATION: MIGRATION_<from>_<to>: …`.
4. Run every restore invariant on the migrated payload: roots, the note tree, nullifiers, mint signatures, in-order transaction replay, balances.
5. The restored ledger keeps the hash of the signed snapshot (`lastCheckpoint()`) and records `restoredFrom = { formatVersion, migrationSteps }`. Its next snapshot is format 7 and links to the old one, so a chain can cross a format change. `restoreChain()` accepts such a mixed chain (`src/testnet/snapshot-migration-chain.test.ts`).

A migration never rewrites transactions, mints or notes. Their ids and signatures bind those bytes, and checkpoints hash the transaction and mint history. A restore warns once (`UEP_DEP_SNAPSHOT_FORMAT`) when it migrated a snapshot.

### Step 6 → 7 (block height, ADR 0002)

Each derivation is pure and needs no clock and no keys:

| Field | Format 7 value | Reason |
|---|---|---|
| `height` | `0` | Format 6 had no block height. The restored ledger starts height-based time at 0 and the operator advances it. Using `sequence` would suggest a link between snapshots and blocks that does not exist. |
| `lastReconcileAt` | `0` | Format 6 stored a Unix-ms value. Turning it into a height would need a clock. It is informational and no rule reads it. |
| `policy.windowHeights` | `ceil(policy.windowMs / 5000)` (60,000 ms → 12) | Same rounding as every other `*Ms` option. `windowMs` is removed. |
| `policy.assetTier`, `policy.assetLimits` keys | old asset ids replaced by `<namespace>/<symbol>` (the namespaced entry wins if both exist) | Section 5 |
| transactions, mints, notes, state and roots | unchanged | Signed and hashed bytes. A transaction's `createdAt` (Unix ms in format 6) stays as historical metadata and no rule reads it. |

### Adding format 8

1. Bump `SNAPSHOT_FORMAT_VERSION` to 8 in `src/testnet/ledger.ts` and change the payload.
2. Append one step `{ from: 7, to: 8, title, derivation, fixtures: ["v7-…json"], migrate }` to `SNAPSHOT_MIGRATIONS`. It must be pure, it must not touch signed bytes, and it must document every derivation. Earlier steps are never edited: 6 → 7 → 8 chains on its own.
3. Generate a golden fixture of format 8 with the new release (`scripts/fixtures/generate-snapshot-fixture.ts`, below) and commit it next to the existing ones.
4. Run `node --experimental-strip-types scripts/check-snapshot-compat.ts --write-lock` to record the new shape in `FORMAT.json`. The lock is only written when every other check passes.
5. Update the table above and the CHANGELOG.

Until all of this is done, `npm run check:snapshot-compat` fails in CI. The fixture test then loads the format 6, 7 and 8 fixtures on every run.

### Golden fixtures

Fixtures are generated once from the source tree of the release that wrote the format, then committed. They are never regenerated by later releases.

    git archive <commit> src | tar -x -C /tmp/fx/<commit>
    node --experimental-strip-types scripts/fixtures/generate-snapshot-fixture.ts \
      --legacy-src /tmp/fx/<commit>/src --commit <commit> --label <label> \
      --out src/testnet/fixtures/snapshots/<label>.json   # add --expect-unmigratable for a refused format

The generator runs a small ledger with the historical code: faucet mints of two assets, a spend each way, a reconcile and two chained snapshots. It then uses the current code to record the expected restore result and one post-restore signed spend. Each fixture holds:

- the signed snapshots;
- the public trust anchors (authority and faucet public keys);
- one signed transaction;
- the expected balances, heights and policy.

Every key is generated in memory and discarded when the generator exits. Fixtures contain **public data only**: no private keys, no mnemonics.

For each fixture, `snapshot-fixtures.test.ts` checks:

- the restore succeeds, with its `restoredFrom` steps;
- the derived height and policy are as documented;
- `restoreChain()` across both snapshots works;
- balances are kept (through `balanceOfAsset`);
- the post-restore spend is accepted;
- a tampered snapshot is refused with `INVALID_SNAPSHOT_HASH`;
- a later snapshot of the restored ledger links to the signed one;
- the migration is pure and deterministic.

## 3. What cannot be made compatible

| Item | Why | What to do |
|---|---|---|
| Snapshot formats 1–5 | They use the SHA-256 field reference hash. Format 6 moved to Poseidon over BN254, which changes note commitments, nullifiers, transaction ids and every root. Spend signatures and mint signatures bind those values, and checkpoints hash them. A conversion would have to re-sign every spend and mint, which needs every owner's key and the mint keys. That is not a deterministic migration a verifier can check, so the restore refuses these formats and gives the reason. | Re-create the testnet state. Mnemonics, keys, account ids and `uep1…` addresses are unchanged. |
| Code that relied on the default wall clock: Marketplace windows that expired by themselves, `prepareSpend()` stamping `Date.now()` | Transitions are clock-free by design (ADR 0002). Nothing can expire on wall-clock time without a clock inside the state machine. | Run the height producer: `new HeightProducer({ ledger }).start()` (`src/service/height-producer.ts`). It seals one block per 5 s of real time, outside the transitions, and windows then expire in real time as before. The smoke test, the quickstart, the 20k simulation and `listenUepHttpApi({ heightProducer })` use it. |
| A Marketplace or paymaster built without a height source (`new DigitalServicesMarketplace()`) | Deliberate break. Before v0.5.0 such an instance read the wall clock; with heights it would keep a counter that never moves, so reservations, cancellations and disputes would silently never expire. It now fails closed with `HEIGHT_SOURCE_REQUIRED`. | Pass `height: () => ledger.height` (with a height producer running). Tests that drive the height by hand pass `testOnlyLocalHeight: true` and call `advanceHeight()`. |
| IoT telemetry signed with a Unix-ms `observedAt`, given to a height-based Marketplace | The machine signs `observedAt`. Rewriting it would break the signature, and converting it inside `deliverTelemetry()` would need a clock. The call fails with `IOT_TELEMETRY_OBSERVED_AT_UNIT`, not with a misleading `IOT_TELEMETRY_STALE`. | Machines sign the Marketplace height (`GET /v1/marketplace/height`). |
| A Unix-ms `issuedAt` passed **in process** to `Marketplace` methods | The Marketplace has no clock to map it. The call fails with `ACTOR_AUTH_ISSUED_AT_UNIT`. | Use the service API or the HTTP adapter, which map it (section 6), or set `auth.issuedAtHeight`. |
| A height source, `testOnlyLocalHeight` and the legacy `testOnlyNowMs` / `now` together (any two), or a `*Heights` option together with its `*Ms` form | The configuration is ambiguous. `CLOCK_CONFIG_CONFLICT` stays. | Pass one of them. |
| Notes minted under an old asset id | A note commitment binds the asset's field encoding. Such notes stay valid and spendable, and their change outputs keep the old encoding. | Nothing to do. `balanceOfAsset(account, id)` counts both encodings for either id. `balanceOf(account, assetFr)` stays per encoding. |
| One payment that would need notes of both encodings of one asset | One transaction carries a single asset encoding. | `preparePayment()` uses notes of one encoding (namespaced first). Make two payments, or consolidate. |
| Lab proofs and keys of circuit v3 | Circuit v4 changes the statement. | Labs only, outside this policy. |

## 4. CI check: `npm run check:snapshot-compat`

`scripts/check-snapshot-compat.ts` runs in `npm run test:all` right after the determinism lint, and as its own CI step. It fails when any of the following is true:

- `SNAPSHOT_FORMAT_VERSION` differs from the format produced by the last migration step;
- a format between the oldest migratable one (6) and the current one has no step, or has more than one;
- a supported format has no golden fixture, or a step's fixture is missing or of another format;
- a fixture of a refused format (1–5) has no stated reason;
- the payload shape (top-level keys and policy keys of a fresh snapshot) differs from `FORMAT.json` while the format number did not change;
- the format number differs from `FORMAT.json`, meaning it was bumped without recording the new shape.

`src/testnet/snapshot-compat-check.test.ts` tests these failures: a bump to 8 without a step, fixture and lock, and an added or removed field without a bump.

## 5. Asset ids: alias table

Since v0.5.0 asset ids are `<namespace>/<symbol>`. The pre-release ids are accepted as **deprecated aliases** (`LEGACY_ASSET_ID_ALIASES` in `src/core/assets.ts`, warning `UEP_DEP_ASSET_ALIAS`):

| Old id | Canonical id |
|---|---|
| `asset:test:eur` | `uep-test/teur` |
| `asset:test:btc` | `uep-test/tbtc` |
| `asset:test:energy` | `uep-test/tenergy` |
| `asset:test:data` | `uep-test/tdata` |
| `asset:global:eur` | `uep-global/eur` |
| `asset:ip:energy` | `uep-sim/senergy` |
| `asset:ip:compute` | `uep-sim/scompute` |

Aliases are accepted:

- **In snapshots:** notes, mints and transactions that carry the old asset encoding are recognized (`findAssetByFr`). Policy keys are migrated (6 → 7) and trust `issuerKeys.assetIds` are resolved.
- **In the API:** `faucet`, `prepareSpend`, `preparePayment`, `balanceOf`, `balanceOfAsset`, `ledgerAssetIdToFr`, `findAsset`, issuer keys, and the Marketplace (`publishListing`, `creditAccount`, `availableBalance`, `searchListings`, treasury reads and value accounting).

Behaviour:

- The Marketplace stores the canonical id.
- A listing or credit signed by an old client over the old id still verifies, because the signature is checked over the terms as signed.
- New notes use the canonical encoding. Notes that already exist keep theirs (section 3).

## 6. Deprecated API shims (v0.5.0)

Each shim converts deterministically and warns once per process with a stable code. `node --no-deprecation` silences the warnings. `node --throw-deprecation` turns them into errors, which is useful in CI to find remaining legacy callers. Every shim is covered by `src/service/compat-shims.test.ts` or the fixture tests.

| Code | Legacy input | Conversion |
|---|---|---|
| `UEP_DEP_ASSET_ALIAS` | old asset id | Section 5 |
| `UEP_DEP_MS_OPTION` | `*Ms` window options (Marketplace, paymaster, IoT) | `ceil(ms / 5000)` heights. In the test-only ms mode they stay in ms. |
| `UEP_DEP_NOW_OPTION` | Marketplace or paymaster `now: () => number` | Renamed `testOnlyNowMs`; `now` is a deprecated alias of it (both → `CLOCK_CONFIG_CONFLICT`). A test-only ms counter (ADR 0002), never a real clock. Removed in 0.6.0. |
| `UEP_DEP_IOT_NOW` | `IoTM2MService` `testOnlyNowMs` / `now` with a height-based Marketplace | Ignored: the service uses the Marketplace height. Before, this threw `CLOCK_CONFIG_CONFLICT`. |
| `UEP_DEP_SPEND_NOW_MS` | `prepareSpend()` / `preparePayment()` with a Unix-ms `now` (≥ 10^11) | Replaced by the ledger height |
| `UEP_DEP_POLICY_WINDOW_MS` | `SecurityPolicy({ windowMs })`, probe `nowMs` | `windowHeights = ceil(windowMs / 5000)` (60,000 ms → 12), the same rounding as in snapshots; a probe `nowMs` counts as `floor(nowMs / 5000)` heights, so a pre-v0.5.0 window keeps its length. |
| `UEP_DEP_ISSUED_AT_MS` | `x-uep-issued-at` or `auth.issuedAt` in Unix ms, through the service API or HTTP | At the boundary, `issuedAtHeight = height − ceil((wallNow − issuedAt) / 5000)` (`legacyMsToHeight`, with the adapter's own clock, `legacyWallClock`). The signature still covers the original `issuedAt`, and freshness is checked on the derived height. |
| `UEP_DEP_SNAPSHOT_FORMAT` | snapshot of an older migratable format | Section 2 |

Defaults that keep old call sites working, with no clock read:

- `MarketplaceReputation.score(sellerId)` and `calculateBayesianReputation(events, sellerId)`: `now` defaults to the latest recorded event stamp. `ticksPerDay` defaults to 86,400,000 when the stamps are Unix ms (pre-v0.5.0 callers) and to 17,280 when they are heights.
- `ledger.lastReconcileAt` keeps its name and holds a height. `lastReconcileHeight` is the clearer alias.
- `balanceOf(account, assetFr)` keeps its signature and meaning (one encoding). `balanceOfAsset(account, asset)` adds up every encoding of an asset.

Values below 10^11 are heights and values at or above it are Unix ms (`LEGACY_MS_THRESHOLD`). 10^11 ms is March 1973, and 10^11 heights at 5 s blocks are about 15,800 years.

**Removal.** The shims above were deprecated in 0.5.0. The test-only millisecond mode (`testOnlyNowMs` / `now`, and `*Ms` options read in ms in that mode) is scheduled for removal in the next minor version, 0.6.0. The other shims stay until at least 0.6.0. A removal needs a CHANGELOG entry and, for HTTP, a major version of `UEP_HTTP_API_VERSION`.

## 7. HTTP API versioning

- `UEP_HTTP_API_VERSION = "1.3.0"`. 1.3.0 adds `GET /v1/marketplace/height` (`{ height, unit, referenceBlockTimeMs }`), the value clients sign as `x-uep-issued-at`. It also accepts the legacy Unix-ms header form.
- Fields are only added within a major version. A removed field, or a changed meaning without a shim, is a major version.
- Every HTTP response carries the version in the `x-uep-api` header.
