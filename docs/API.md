# Public API reference: changed signatures (v0.4.3 – v0.5.0)

This page lists the public signatures that changed in `0.5.0-public-iot-m2m` (unreleased), `0.4.7-public-iot-m2m`, `0.4.6-public-iot-m2m`, `0.4.5-public-iot-m2m`, `0.4.4-public-iot-m2m` and `0.4.3-public-iot-m2m`, newest first. Everything else is unchanged; see the source for full types. Error codes are thrown as `Error(message)` where the message starts with the code. Ledger submit errors are returned as `{ error: { code, message } }`.

# v0.5.0 (unreleased)

## HTTP adapter and service API: `src/service/uep-http-api.ts`, `uep-service-api.ts`, `uep-api-types.ts`

- `UEP_HTTP_API_VERSION = "1.3.0"` (1.3.0 adds `GET /v1/marketplace/height`; see "Compatibility" below).
- Signed actor headers: `x-uep-actor-id`, `x-uep-signature` (hex Ed25519 signature over `actionMessage({ marketplaceId, action, actorId, target, details })`), `x-uep-issued-at` (Marketplace height since v0.5.0, see below; required for `read`). Exported as `ACTOR_ID_HEADER`, `ACTOR_SIGNATURE_HEADER`, `ACTOR_ISSUED_AT_HEADER`. `x-uep-caller-id` is ignored.
- `ApiRequestMeta.auth?: { actorId, signature, issuedAt? }`; `callerId` is informational only.
- Marketplace and IoT methods fail closed: no `auth` → `UNAUTHORIZED` (401); Marketplace errors map to `UNAUTHORIZED` (`ACTOR_SIGNATURE_*`, `IDENTITY_NOT_REGISTERED`, `RESERVATION_SIGNATURE_INVALID`, …), `FORBIDDEN` (`*_FORBIDDEN`, `*_NOT_AUTHORIZED`), `NOT_FOUND` or `INVALID_REQUEST`. `httpStatusOf(result, okStatus)` gives the HTTP status of a result.
- `marketplaceFundOrder(orderId, amount, meta)`, `marketplaceDeliverOrder(orderId, body, expectedHash?, meta)` (no provider id: the provider is the signer), `marketplaceSettleOrder(orderId, meta)`, `marketplaceCancelOrder(orderId, meta)`, `marketplaceGetOrder(orderId, meta)`, `marketplacePublishListing(input, meta)` pass `meta.auth` to the Marketplace. `marketplaceAcceptOrder()` requires the reservation `signature`. `marketplaceTreasury(asset, meta)` requires an administrator `read` signature over `treasury:<asset>`. `iotHold`, `iotDeliverTelemetry`, `iotSettle` require `meta.auth`; `iotRequestService` requires `authorization`.
- `HttpApiOptions.cors?: { allowedOrigins: string[] }` (else `UEP_HTTP_CORS_ORIGINS`); `OPTIONS` → 204. `HttpApiOptions.objectsToken` protects `/v1/objects*` (without it: loopback hosts only, else 401 `OBJECTS_AUTH_REQUIRED`).

## Marketplace: `src/marketplace/marketplace.ts`, `paymaster.ts`

- `treasurySnapshotAuthorized(asset, auth)`: administrator `read` signature over `treasury:<asset>` (with `issuedAt`); else `TREASURY_ACCESS_FORBIDDEN`.
- `MarketplacePaymaster` config: `maxOutstandingPerActor` (32), `maxActorShareBps` (2500), `maxOrderShareBps` (1000), `maxGasPerOrder?`. Errors `PAYMASTER_ACTOR_LIMIT_REACHED`, `PAYMASTER_ACTOR_CAP_EXCEEDED`, `PAYMASTER_ORDER_CAP_EXCEEDED`, `INVALID_SPONSOR_HOLD`.
- `sponsor(orderId, quote, now?, { actorId?, holdUntil? })`, `pin(orderId, quoteId)`, `sweepExpired(now?, limit?)` (returns released order ids), `isSponsored()`, `outstandingOf(asset)`, `actorOutstandingOf(actorId, asset)`, `openSponsorships()`. `release(orderId, { quoteId })` is idempotent; captured sponsorships keep only their receipt.
- `publishListing()` uses a fingerprint index and a prefix-filter token index (same results as before).

## Ledger and spends: `src/testnet/ledger.ts`, `src/core/spend-proof.ts`, `src/core/nullifier.ts`

- `prepareSpend(secrets, recipient, asset, amount, now?, opts?)` and `preparePayment(…, opts?)` with `SpendBuildOptions = { authorization?: "sender-signature" | "development-mac" }`; default `"sender-signature"`.
- `SpendProof.kind` adds `"sender-signature"`; `SENDER_SIGNATURE_PROOF` (`backend: "ed25519-key-derived-account"`, empty payload). `signedSpendNullifier(senderId, nonce)`, `SIGNED_SPEND_NULLIFIER_TAG`.
- `submit(tx)` accepts a `sender-signature` spend without secrets (sender signature, input owner keys and sender-bound nullifier checked; `WRONG_OWNER` for another nullifier). A `development-mac` spend still needs `submit(tx, secrets)` (`PROOF` otherwise). Restore fails with `INVALID_SNAPSHOT_TX_NULLIFIER` for a signed spend with another nullifier.

## Assets: `src/core/assets.ts`, `src/core/asset-registry.ts` (new)

- Asset ids `<namespace>/<symbol>` (`ASSET_ID_PATTERN`, `parseAssetId`, `isCanonicalAssetId`, `assetIdToFr`); `MAX_ASSET_DECIMALS = 8`, `assertAssetDecimals`. `AssetRecord` gains `kind` and `measurement`; `issuer` is the namespace. `assetTemplatesForNetwork(networkId)`, `devAssetRegistry(networkId)` (ephemeral keys, local only).
- Manifest types and tooling: `KeySet`, `normalizeKeySet`, `validSigners`, `meetsThreshold`, `selfCertifiedNamespace`, `assetAdmissionMessage`, `assetRegistryManifestHash`, `validateAssetRegistryManifest`, `validateAssetRegistryUpgrade`, `verifySignedAssetRegistry`, `AssetRegistry.load(chain, governance)` (`withVersion`, `find`, `findByFr`, `feeFloor`, `issuerAt`, `allIssuerKeys`), `buildSignedAssetRegistry`, `cosignAssetRegistry`.

## Sparse Merkle tree: `src/core/smt.ts`

- Same API and results; compressed storage. New `storedNodeCount()`. The constructor rejects depths outside 1–254 (`SMT_DEPTH_INVALID`).

## Labs

- `verifyZkSpendProofAgainstExpected(…, depth = 4)`, `verifyArtifactAgainstRoots(art, old, newRoot?, depth = 4)`; `src/lab/zk-vk-pins.ts` (`loadVkPins`, `pinnedVk`, `zkVerifyPinned`, codes `VK_NOT_PINNED`, `VK_PIN_MISMATCH`, `DOMAIN_MISMATCH`, `INVALID_PROOF`). `VerifyingKeyRegistry.pin()` requires a pinned key. `accountIndex(owner, depth, asset?)`, `stateKey(owner, asset)`. `zkStateIndex()` in `zk-bridge.ts`.

## Deterministic transitions, domain profiles and evidence caps (ADR 0002)

Background: `docs/adr/0002-deterministic-transitions.md`, `docs/EVIDENCE.md`. Every window below is in block heights (5 s reference block time; `ms` options are converted with ceil).

- **New modules.**
  - `src/core/height.ts`: `REFERENCE_BLOCK_TIME_MS = 5000`, `HEIGHTS_PER_DAY = 17_280`, `heightsForMs(ms)` (ceil), `msForHeights(h)`, `HeightCounter`, `TransitionClock.from({ height?, testOnlyLocalHeight?, testOnlyNowMs?, now? })`: exactly one of `height`, `testOnlyLocalHeight: true` or `testOnlyNowMs` (deprecated alias `now`), else `HEIGHT_SOURCE_REQUIRED`; more than one → `CLOCK_CONFIG_CONFLICT`. Unit `"height"` or test-only `"legacy-ms"` (removed in 0.6.0). A height that goes backwards → `HEIGHT_REGRESSED`. `clock.sameSourceAs(other)` compares the height function itself (legacy-ms: the unit). `heightOf(target)` returns one memoized `() => target.height` per target. `MAX_BLOCKS_PER_TICK = 12`.
  - `src/core/test-only.ts`: `isProductionEnvironment()`, `testOnlyOption(name, value, kind)` (`TEST_ONLY_OPTION_INVALID`, `TEST_ONLY_OPTION_IN_PRODUCTION` under `NODE_ENV=production`), `assertNoTestOnlyOptions(value, where?)` and `parseUntrustedOptions(json)` (`TEST_ONLY_OPTION_UNTRUSTED` for any `testOnly*` or `now` key at any depth).
  - `src/core/ed25519-point.ts`: `isPrimeOrderEd25519Point(raw32)`, `normalizeEd25519PublicKeyHex(hex)` (raw or SPKI DER hex → 64 lowercase hex; throws on zero, identity, small-order, non-canonical or off-curve keys).
  - `src/core/domain-profiles.ts`: `DomainProfileId = "EARTH" | "MOON" | "MARS"`, `DOMAIN_PROFILES` (delay 0, 1 and 602 heights), `domainProfile(id)`, `isDomainProfileId`, `delayHeightsFor(ms)`, `DEFAULT_DOMAIN_PROFILE = "EARTH"`.
  - `src/marketplace/evidence.ts`: `EvidenceStatement` (type only), `AttesterSetPolicy` (`attesterSetId`, `sourceId`, `attesterKeys`, `threshold`, `size`, `valueCaps`, `providerCapBps?`), `DEFAULT_PROVIDER_CAP_BPS = 2500`, `ListingEvidencePolicy`, `EvidenceCapsConfig`, `EvidenceCaps`, `EvidenceCapsView`, `evidenceCapsView(caps)`.
  - `src/service/height-producer.ts`: `HeightProducer({ ledger, blockTimeMs = 5000, clock = performance.now, wallClock = Date.now, wallClockJumpToleranceMs?, maxBlocksPerTick = 12, onBlocks?, log = console.warn })` with `tick()` (seals the blocks monotonic time allows, at most `maxBlocksPerTick`; returns the number sealed), `allowedHeight()`, `start()` / `stop()` (unref'd timer), `rebind(ledger)`, `running`, `status()` → `{ height, allowedHeight, aheadBy, blockTimeMs, maxBlocksPerTick, running, droppedBlocks, wallClockJumps }`. Log events: `wall-clock-jump`, `catch-up-capped`, `stopped` (e.g. `LEDGER_RETIRED`). `wallClock` is only used to log jumps (off when only `clock` is injected). `MIN_BLOCK_SPACING_MS = 5000` (`HEIGHT_PRODUCER_BLOCK_SPACING` below it). `ProducedHeight({ testOnlyUnboundedHeightAdvance? })`: a standalone height target for a Marketplace without a ledger (12 blocks per call). Node tooling, outside the transitions.
  - `src/network/profiles.ts`: `NetworkProfile.referenceBlockTimeMs` (`TESTNET`: 5000).
- **Ledger** (`src/testnet/ledger.ts`): `height` getter and `advanceHeight(blocks = 1)` (`HEIGHT_ADVANCE_INVALID`; more than 12 → `HEIGHT_ADVANCE_CAP` unless the ledger was built with `testOnlyUnboundedHeightAdvance: true`; `LEDGER_RETIRED` after `retire()`). `retire()` / `isRetired`. `acceptsRecipient(id)`: v3 id, or v2 id proven by a committed spend. `restore(snapshot, trust, keys?, opts?)` / `restoreChain(…, opts?)` with `RestoreOptions { replaces?, minHeight?, allowHeightRegression? }` (`INVALID_SNAPSHOT_HEIGHT_REGRESSION`); `SnapshotCheckpoint.height?`. `prepareSpend()` / `preparePayment()` default `now` is the ledger height (it was `Date.now()`), so `createdAt` and `lastReconcileAt` are heights. Policy probes carry the height.
- **Snapshots: format version 7.** The payload adds `height` (non-negative safe integer, `INVALID_SNAPSHOT_HEIGHT`; `lastReconcileAt` may not exceed it). Format 6 snapshots are migrated (see "Compatibility" below); format 5 and older are refused.
- **Security policy** (`src/core/security-policy.ts`): `windowHeights` (default 12) replaces `windowMs`. `windowMs` is still accepted and converted to `windowHeights = ceil(windowMs / 5000)` (60,000 ms → 12; `CLOCK_CONFIG_CONFLICT` if both are given; `POLICY_WINDOW_INVALID` if not positive). `SpendProbe.height` replaces `nowMs`; a legacy `nowMs` (read when `height` is absent) counts as `floor(nowMs / 5000)` heights. `windowVolume(account, asset, at?)` has no clock default.
- **Marketplace** (`src/marketplace/marketplace.ts`):
  - Config `height?: () => number` (e.g. `() => ledger.height`). **Required**: without a height source the constructor throws `HEIGHT_SOURCE_REQUIRED`. Tests may pass `testOnlyLocalHeight: true` for a local counter at 0 that only `advanceHeight(blocks = 1)` moves (`HEIGHT_SOURCE_EXTERNAL` when a source is injected). `testOnlyNowMs?` (deprecated alias `now?`) is a test-only ms counter (windows are then in ms; removed in 0.6.0). `timeUnit`, `transitionClock` and `clock()` expose the time source.
  - Window options in heights: `reservationTtlHeights` (120), `cancellationGraceHeights` (24), `deliveryDisputeWindowHeights` (17_280), `disputeResolutionWindowHeights` (120_960), `readAuthorizationTtlHeights` (60), `listingWindowHeights` (720). The `*Ms` options remain as legacy forms (converted; giving both → `CLOCK_CONFIG_CONFLICT`). `DEFAULT_*_HEIGHTS` constants are exported. The `*Ms` readonly fields hold nominal ms. `baseWindows` holds the ticks.
  - `publishListing(input: ListingInput, auth)`: optional `domainProfile` (default `"EARTH"`, `DOMAIN_PROFILE_INVALID`) and `evidencePolicy`. Listings gain `domainProfile`, `delayHeights`, `windows: ContractWindows` (`referenceBlockTimeMs`, `domainDelay`, `reservationTtl`, `cancellationGrace`, `deliveryDisputeWindow`, `disputeResolutionWindow`), and `evidencePolicy?`. All are fixed at publication; inside the Marketplace every listing field except `available` and `active` is non-writable. `contractWindowsFor(profile)`.
  - Orders gain `domainProfile`, `windows` (copied from the listing) and `evidenceLocked?` (set when the order is funded). Cancellation, expiry, delivery dispute and dispute resolution use `order.windows`.
  - `listingTerms()` (`identity.ts`) signs `domainProfile` when it is not `EARTH`, and `evidencePolicy` when present. Existing EARTH listings keep the same terms and signatures.
  - Config `evidence?: { attesterSets?: AttesterSetPolicy[] }` (default none; keys normalized and validated, `EVIDENCE_ATTESTER_SET_INVALID`; `EVIDENCE_ATTESTER_SET_DUPLICATE` when a key is already in another set). `EVIDENCE_PROVIDER_CAP_EXCEEDED` for the provider subcap (at publication when `maxValuePerContract` exceeds it, at reserve and funding). When `fundOrder()` fails on a full cap, the order closes `CANCELLED` with `closeReason: "EVIDENCE_CAP_FULL"` and the deposit is returned. `reserve()` throws `EVIDENCE_CONTRACT_CAP_EXCEEDED`, or `EVIDENCE_ATTESTER_SET_CAP_EXCEEDED` when the set is already full, before moving value; `fundOrder()` takes the set cap (`EVIDENCE_ATTESTER_SET_CAP_EXCEEDED` before moving value); settlement rechecks the per-contract cap. `evidenceCaps` is a read-only view: `openValue(setId, asset)` (funded open value), `providerOpenValue(setId, asset, providerId)`, `providerCap(setId, asset)` and `attesterSet(setId)`.
  - `attachCategoryService(category, hooks)` throws `CATEGORY_SERVICE_IN_USE` when the category already has listings or orders, and `CATEGORY_HOOKS_INVALID` for a non-function hook; it stores a frozen copy. Listings are not extensible; `order.windows` is frozen.
  - A paymaster whose height source differs from the Marketplace's → `CLOCK_CONFIG_CONFLICT`.
- **Account ids and addresses v3** (`src/core/spend-key.ts`, `src/core/address.ts`): `ACCOUNT_ID_VERSION = 0x03`, `ACCOUNT_ID_VERSION_V2 = 0x02`. `accountIdFromSpendKey(pk)` → `0x03 ‖ SHA-256("UEP-ACCOUNT-KEY-v3\n" ‖ raw32(pk))[0..23] ‖ SHA-256("UEP-ACCOUNT-CHECK-v3\n" ‖ 0x03 ‖ keyHash)[0..8]`. `accountIdFromSpendKeyV2`, `accountIdsOfSpendKey`, `accountIdsFromSecrets`, `spendKeyHashV2` (`spendKeyHash` deprecated alias), `spendKeyBodyV3`, `accountIdFromKeyHash(body, version)` (`ACCOUNT_ID_CHECK`), `isKeyDerivedAccountId(id)` (v3 with a valid check), `isV2AccountIdForm(id)`, `accountIdFormat(id)` → `"v3" | "v2-form" | "legacy"` (a v2-form id has the v2 version byte; whether a key stands behind it is only known once the key is revealed). `ADDRESS_VERSION = 3`, `ADDRESS_VERSION_V2 = 2`; `decodeAccountAddress` returns `version: 2 | 3` and fails with `ADDRESS_ID_CHECK` on a v3 address whose id check fails. `IdentitySecrets.accountIdV2?`, `withAccountIdV2(secrets)` (`src/identity/kdf.ts`).
  - `checkoutQuote()` lines add `domainProfile`, `delayHeights`, `reservationTtlHeights` and `cancellationGraceHeights`. The `*Ms` fields there are nominal.
  - Read and list authorizations: `issuedAt` is a Marketplace height (`m.clock()`), valid for `readAuthorizationTtlHeights`. The HTTP header `x-uep-issued-at` carries that number.
  - A paymaster with another time unit than the Marketplace → `CLOCK_CONFIG_CONFLICT`.
- **Paymaster** (`paymaster.ts`): `height?` (required, or `testOnlyLocalHeight: true`, or the test-only `testOnlyNowMs?` / deprecated `now?`), `quoteTtlHeights` (default 120; `quoteTtlMs` converted). New `quoteTtl` (ticks) and `clock`; `quoteTtlMs` is a nominal getter.
- **Treasury** (`economy.ts`): `MarketplaceTreasury({ height? })`; entry timestamps default to that height (the Marketplace passes its own), not `Date.now()`.
- **Reputation** (`reputation.ts`): `MarketplaceReputation.score(sellerId, now?, ticksPerDay?)` and `calculateBayesianReputation(…, now?, prior, priorWeight, ticksPerDay?)`. Ages are measured in heights. Without `now` the default is the latest recorded event stamp, with no clock read (see "Compatibility" below).
- **IoT/M2M** (`src/service/iot-m2m.ts`): the default time source is the Marketplace clock. `testOnlyNowMs` (deprecated alias `now`) is only used with a test-only ms Marketplace; with a height-based Marketplace it is ignored with a deprecation warning (`UEP_DEP_IOT_NOW`). Config options: `telemetryMaxAgeHeights` (60) and `telemetryMaxFutureSkewHeights` (6), with the legacy `*Ms` forms converted. Readonly `telemetryMaxAge` and `telemetryMaxFutureSkew`. The telemetry age window of an order is the base window plus `order.windows.domainDelay` (MARS: 662 heights). `observedAt` is a height (`IOT_TELEMETRY_OBSERVED_AT_INVALID` if it is not a finite number, `IOT_TELEMETRY_OBSERVED_AT_UNIT` if it looks like Unix ms with a height-based Marketplace). Exports `DEFAULT_TELEMETRY_MAX_AGE_HEIGHTS` and `DEFAULT_TELEMETRY_MAX_FUTURE_SKEW_HEIGHTS`.
- **Scripts**: `npm run lint:determinism` (`scripts/check-deterministic-transitions.mjs`, exports `checkRepository`, `scanSource`, `RULES`, `ALLOWLIST`; allowlist entries may carry `match` to cover specific lines only). It runs first in `npm run test:all`. `npm run test:poisoned-clock` runs the testnet, Marketplace, IoT, compatibility, HTTP and height-producer suites with `scripts/poisoned-clock-preload.mjs` (`scripts/poisoned-clock.mjs`: `installPoisonedClock(classes)`, `defaultTransitionClasses(srcRoot)`, `takeViolations()`, `poisonedClockInstalled()`).

## Compatibility: snapshot migrations, asset aliases and deprecated shims (ADR 0003)

Policy: `docs/COMPATIBILITY.md`. Background: `docs/adr/0003-compatibility-and-migrations.md`.

- **Snapshot migration registry** (`src/testnet/snapshot-migrations.ts`, new):
  - `SNAPSHOT_MIGRATIONS` (append-only steps `{ from, to, title, derivation, fixtures, migrate }`) and `migrateSnapshotPayload(payload)` (pure; returns `{ payload, steps }`);
  - `snapshotFormatSupport(formatVersion)` (`current`, `migratable`, `unmigratable` with a reason, or `unknown`);
  - `OLDEST_MIGRATABLE_SNAPSHOT_FORMAT = 6`, `UNMIGRATABLE_SNAPSHOT_FORMATS`, `latestSnapshotFormat()`, `migrationRegistryProblems(current)`.
- **Restore.** `restore()` / `restoreChain()` accept format 6 snapshots. Hash, signatures, chain link and checkpoint are checked on the snapshot as signed, then step 6 → 7 runs:
  - `height = 0` and `lastReconcileAt = 0`;
  - `policy.windowHeights = ceil(windowMs / 5000)`;
  - policy asset keys are canonicalized.

  A chain may mix formats 6 and 7. Errors:
  - `INVALID_SNAPSHOT_MIGRATION: MIGRATION_6_7: …`: the step rejects its input;
  - `INVALID_SNAPSHOT_VERSION`: format 5 or older (with the reason), or a newer format.
- **Ledger** (`src/testnet/ledger.ts`):
  - `restoredFrom?: { formatVersion, migrationSteps }`.
  - `balanceOfAsset(account, assetId)`: the balance by asset id, adding up the canonical and the legacy encoding.
  - `lastReconcileHeight` (getter, the same value as `lastReconcileAt`).
  - `prepareSpend()` / `preparePayment()` with a Unix-ms `now` use the ledger height (`UEP_DEP_SPEND_NOW_MS`).
  - A payment uses notes of one asset encoding.
- **Snapshot JSON** (`src/testnet/snapshot-json.ts`, new): `snapshotToJSON(snapshot)`, `snapshotFromJSON(text)`, `reviveSnapshotBigints(value)`. Bigints are written as `"<digits>n"`, the form `snapshotHash` uses.
- **Asset aliases** (`src/core/assets.ts`):
  - `LEGACY_ASSET_ID_ALIASES`, `isLegacyAssetIdAlias(id)`, `resolveAssetIdAlias(id)` (`UEP_DEP_ASSET_ALIAS`), `legacyAliasesOf(id)`, `assetEncodings(canonicalId)`, `isLegacyAssetEncoding(assetFr)`.
  - `findAsset`, `findAssetByFr` and `ledgerAssetIdToFr` accept aliases or legacy encodings. Ledger and Marketplace entry points resolve aliases.
  - `publishListing()` and `creditAccount()` verify the signature over the asset id as signed and store the canonical id.
- **Deprecations** (`src/core/deprecation.ts`, new): `DEPRECATIONS` (stable codes), `deprecate(code, message)` (one `DeprecationWarning` per code and process), `emittedDeprecations()`, `LEGACY_MS_THRESHOLD = 10^11`, `looksLikeLegacyMs(value)`. Warnings are emitted for `*Ms` options (`UEP_DEP_MS_OPTION`), the `testOnlyNowMs` / `now` counter (`UEP_DEP_NOW_OPTION`) and `SecurityPolicy({ windowMs })` or a probe `nowMs` (`UEP_DEP_POLICY_WINDOW_MS`).
- **Height helpers** (`src/core/height.ts`): `legacyMsToHeight(timestampMs, currentHeight, wallNowMs)` (pure; for boundary adapters).
- **Security policy**: `toPolicyBigint(value)` (bigint, safe integer, `"123"` or `"123n"`; else `INVALID_POLICY_AMOUNT`).
- **Actor authorization** (`identity.ts`, `marketplace.ts`, `uep-service-api.ts`):
  - `ActorAuth.issuedAtHeight?`: the height a boundary adapter derived from a legacy Unix-ms `issuedAt`. It is not signed; the signature still covers `issuedAt`.
  - The service API and the HTTP adapter derive it with `legacyMsToHeight` and their own clock (`ServiceApiConfig.legacyWallClock`, default `Date.now`; `UEP_DEP_ISSUED_AT_MS`).
  - In process, a Unix-ms `issuedAt` without `issuedAtHeight` on a height-based Marketplace fails with `ACTOR_AUTH_ISSUED_AT_UNIT`.
- **Service API and HTTP**: `marketplaceHeight(meta?)` and `GET /v1/marketplace/height` → `{ height, unit, referenceBlockTimeMs }` (public). `UEP_HTTP_API_VERSION = "1.3.0"`.
- **Height producer**: see `src/service/height-producer.ts` above. `listenUepHttpApi({ ..., heightProducer })` starts it when the server listens and stops it on close. It rejects with `HEIGHT_PRODUCER_REQUIRED` when the API serves a Marketplace on an injected height source and no producer is given, and `HEIGHT_PRODUCER_INVALID` for an object that is not a producer. `needsHeightProducer(api)`.
- **Snapshots and generic JSON codecs**: transactions are serialized with their notes in one canonical form (`canonicalSerializedNote`, `canonicalSerializedTx` in `src/core/transaction.ts`), and the transaction chain hash is computed over that form. A snapshot that went through a bigint-preserving JSON codec restores, and repeated restarts keep the payload byte-identical. `snapshotToJSON` / `snapshotFromJSON` remain the canonical disk codec (policy bigints as `"<digits>n"`); the snapshot format is unchanged.
- **Scripts**:
  - `npm run check:snapshot-compat` (`scripts/check-snapshot-compat.ts`, exports `checkSnapshotCompat(overrides?)` and `currentShape()`; `--write-lock`);
  - `scripts/fixtures/generate-snapshot-fixture.ts`;
  - golden fixtures in `src/testnet/fixtures/snapshots/` (`FORMAT.json` lock).

# Unreleased: Poseidon protocol hash

## Hash: `src/core/poseidon.ts` (new), `src/core/hash.ts`

- `poseidon2(a, b)`: Poseidon over BN254 (x^5, t = 3, state `[0, a, b]`, 8 full + 57 partial rounds, circomlib-compatible constants). Inputs must be canonical field elements (`POSEIDON_INPUT_NOT_CANONICAL`).
- `poseidonDomainHash(domain, a, b) = poseidon2(poseidon2(domain, a), b)`.
- The active backend is `PoseidonBn254Hash` (`uep-poseidon-bn254-x5-3-v1`). `Sha256FieldReferenceHash` is the previous backend, kept inactive; `Uep25PrototypeHash` is a deprecated alias of it.
- Note commitments, nullifiers, SMT and note-tree nodes, transaction commitments and transaction ids change value. Account ids and addresses do not change.

## Snapshots (format version 6)

`SNAPSHOT_FORMAT_VERSION = 6`. Fields and restore checks are those of format 5; the values of commitments, nullifiers and roots are Poseidon-based. Formats 3–5 are rejected (`INVALID_SNAPSHOT_VERSION`).

# v0.4.7

Multi-asset hardening. No ledger, address, note, transaction or snapshot format change (snapshot format stays 5); existing v0.4.6 snapshots restore unchanged if they only contain registered assets.

## Assets and fees: `src/core/assets.ts`, `src/core/fee.ts`, `src/core/composite-key.ts` (new)

- `LEDGER_ASSET_ID_PATTERN`, `isCanonicalLedgerAssetId(id)`, `ledgerAssetIdToFr(id)` (throws `ASSET_ID_INVALID`): ledger asset ids are lowercase ASCII, 1–31 bytes, so their field encoding is injective. `findAssetByFr(networkId, fr)`.
- `validateAssetRegistry(records): string[]`: canonical, unique ids, distinct encodings, integer `decimals` in `[0, MAX_REGISTRY_DECIMALS]` (18), `minProtocolFee >= 1`.
- `AssetRecord.minProtocolFee?: bigint`: per-asset protocol fee floor (default 1; every registered asset keeps 1).
- `creatorFee(amount, minFee = 1n)`, `requiredSenderDebit(amount, minFee = 1n)`, `transition(old, amount, minFee = 1n)`: the rate stays 0.1% (10 bps). New `maxPayableFromNote(noteValue, minFee)` and `effectiveFeeBps(amount, minFee)`.
- `tupleKey(...parts)` and `NestedAmountMap`: injective composite keys and per-outer-key totals.

## Security policy: `src/core/security-policy.ts`

- `SecurityPolicyConfig.assetLimits: Record<assetId, { maxTransferAmount?, maxTransferPerWindow?, minTransferAmount? }>`; `setAssetLimits(assetId, limits)`, `limitsFor(assetId)`, `windowVolume(account, assetId, now?)`, `checkSequence(probes)` (never mutates state).
- The rolling volume is tracked per (account, asset); the spend count per window stays per account. New reject code `AMOUNT_TOO_SMALL`.

## Ledger: `src/testnet/ledger.ts`

- `requireProof` is a read-only getter; assigning `false` throws `REQUIRE_PROOF_IMMUTABLE`. Constructor option `testOnlyDisableProof` (tests only). Restored ledgers always require it.
- Constructor option `issuerSigningKeys: Record<assetId, PrivateKeyLike>`; `setIssuerSigningKey(assetId, key | null)` (install / rotate / remove), `issuerPublicKeys()`. An asset with an issuer key is minted only with that key (`ISSUER_ASSET_UNKNOWN`, `ISSUER_KEY_NOT_DISTINCT`).
- `SnapshotTrust.issuerKeys?: { publicKey, assetIds, fromMintIndex? }[]` and `SnapshotTrust.revokedMintKeys?: { publicKey, fromMintIndex }[]`. Once an asset has a scoped issuer key, `faucetPublicKeys` no longer validate its mints. `LedgerSigningKeys.issuerSigningKeys` (`ISSUER_KEY_NOT_TRUSTED`).
- `restore()` rejects notes and mints of unregistered assets (`INVALID_SNAPSHOT_NOTE_ASSET`, `INVALID_SNAPSHOT_MINT_ASSET`) and mints not signed by a key trusted for that asset and mint index (`INVALID_SNAPSHOT_MINT_SIGNATURE`).
- `submit()` returns `ASSET_MISMATCH` when a transported input or output note is not in the transaction asset. `prepareSpend()` returns `ASSET_MISMATCH` for unregistered or non-canonical asset ids (previously `INSUFFICIENT`).
- `preparePayment(secrets, recipient, assetId, amount, now?) => { txs } | { error, index? }` and `submitBatch(txs, secrets?)`: atomic payment from several notes as up to `MAX_PAYMENT_PARTS` (16) single-input spends of one sender, asset and recipient; each part pays its own fee; all parts are accepted or none. New code `BATCH_INVALID`. `protocolFeeFloor(networkId, assetFr)`.

## Marketplace: `src/marketplace/marketplace.ts`, `economy.ts`, `identity.ts`, `testkit.ts`

- Balances (available, locked deposits, held escrow) are indexed by asset, then identity. Idempotency keys and the listing index use structural keys.
- Asset ids must match `MARKETPLACE_ASSET_ID_PATTERN` (`ASSET_ID_INVALID`). Config `assetRegistryNetworkId` restricts listings and credits to the assets registered on that ledger network (`ASSET_NOT_REGISTERED`). `assertAsset(asset)`.
- Identity ids: at most `MAX_IDENTITY_ID_LENGTH` (256) characters, no control characters (`IDENTITY_ID_INVALID`).
- Config `minReservationDepositByAsset` and `minReservationDepositFor(asset)`; `reservationDepositFor(gross, gas, asset?)`. `MarketplaceTreasury({ minFeeByAsset })`, `minFeeFor(asset)`; `calculateMarketplaceFee(gross, bps, minFee)`, `quoteSettlement(gross, asset, bps, minFee)`. The rate stays 3% (300 bps) and the defaults are unchanged.
- Config `requireSignedCredits`: `creditAccount(identityId, asset, amount, { creditId, auth })` then needs the administrator's `"credit"` signature over `{ asset, amount, creditId }`; each `creditId` is accepted once (`CREDIT_AUTHORIZATION_REQUIRED`, `CREDIT_NOT_AUTHORIZED`, `CREDIT_REPLAY`). New action `"credit"`; test helper `creditAs()`.

# v0.4.6

## Marketplace: `src/marketplace/marketplace.ts`

```ts
type CategoryServiceHooks = {
  settlementGuard?: (order: ServiceOrder) => void;   // now also gates a RELEASE dispute timeout
  consumedUnits?: (order: ServiceOrder) => bigint;   // new: units proven executed (clamped to [0, quantity])
};
ServiceOrder.disputeOutcome   // + "TIMEOUT_REFUND_UNVERIFIED"
ServiceOrder.capacityConsumed?: bigint   // units kept consumed when the order closed
ServiceOrder.capacityRestored?: bigint   // units returned to the listing (set exactly once)
SettlementRecord.categoryGuard?: "PASSED" | "TIMEOUT_REFUNDED" | "ARBITER_OVERRIDE"   // guarded categories only
SettlementRecord.capacityRestored?: bigint
capacityAccounting(listingId): CapacityAccounting
type CapacityAccounting = { listingId, capacity, available, reserved, consumed, conserved }
```

- **Dispute timeout (UEP-D04).**
  - With `disputeTimeoutOutcome: "RELEASE"`, `settle()` on a timed-out dispute pays the provider only if the category guard passes. The outcome is then `RELEASE`, with `disputeOutcome` `TIMEOUT_RELEASE` and `categoryGuard` `PASSED` for guarded categories.
  - Otherwise the order closes as `REFUND_BUYER`, with `disputeOutcome` `TIMEOUT_REFUND_UNVERIFIED` and `categoryGuard` `TIMEOUT_REFUNDED`.
  - A category is guarded if it is `IOT_M2M` or has a `settlementGuard` attached. An IoT listing without an attached IoT service always fails the guard.
- **Guarded release paths:** `settle()` on DELIVERED orders, the buyer's dispute withdrawal, and the RELEASE timeout.
- **Arbiter resolution.** `resolveDispute()` RELEASE / SPLIT is not blocked by the guard (arbiter trust). Its record carries `categoryGuard` `PASSED` or `ARBITER_OVERRIDE` for guarded categories. REFUND_BUYER never carries it.
- **Capacity (UEP-D05).** When an order closes, capacity returns exactly once:
  - cancel / expire: the full quantity;
  - full release: 0;
  - refund / split: `quantity − max(consumedUnits evidence, ceil(providerAmount × quantity / gross))`.
- The capacity check runs before any value moves. Errors: `CAPACITY_ALREADY_RESTORED`, `CAPACITY_ACCOUNTING_INVALID`. `available` never exceeds `capacity`.
- `capacityAccounting()` is public listing data: open orders count as `reserved`, closed orders as `consumed` (`capacityConsumed`).

## IoT/M2M: `src/service/iot-m2m.ts`

- The attached hooks are `settlementGuard` (now also used by the RELEASE timeout) and `consumedUnits`.
- `consumedUnits` returns the `unitsDelivered` of the verification bound to the order's delivered report, or 0 if there is none.
- The guard additionally requires `verification.unitsDelivered === order.quantity` (`IOT_USAGE_SHORTFALL`).

# v0.4.5

## Key-derived accounts: `src/core/spend-key.ts`

```ts
ACCOUNT_ID_VERSION = 0x02
deriveSpendKey(secret, salt): { privateKey, publicKeyHex }   // unchanged (deterministic Ed25519)
accountIdFromSpendKey(publicKey): Fr        // 0x02 || SHA-256("UEP-ACCOUNT-KEY-v2\n" || raw32(publicKey))[0..31]
accountIdFromSecrets(secret, salt): Fr      // = accountIdFromSpendKey(deriveSpendKey(secret, salt).publicKeyHex)
isKeyDerivedAccountId(id): boolean          // leading byte 0x02
spendKeyHash(publicKey), accountIdFromKeyHash(hash31), keyHashOfAccountId(id), rawEd25519PublicKey(publicKey)
spendKeyMatchesAccount(publicKey, accountId): boolean
senderAuthFailure(tx): "MISSING" | "OWNER_KEY" | "SIGNATURE" | undefined
verifySenderAuth(tx): boolean               // was verifySenderAuth(tx, registeredPublicKey)
```

**Removed:** `SpendKeyRegistration`, `spendKeyRegistrationMessage()`, `verifySpendKeyRegistration()`.

- `IdentitySecrets.accountId` is now key-derived. The new `IdentitySecrets.spendPublicKey` is the key it commits to.
- `verifyOwnership(secret, salt, id)` compares against `accountIdFromSecrets`.
- `hAccount()` is still the state-tree leaf-key hash; it is no longer an identity derivation.

## Addresses: `src/core/address.ts` (UEP-ADDR-002)

```ts
ADDRESS_VERSION = 2; ADDRESS_HRP = "uep"
encodeAccountAddress(networkId, accountId): string            // Bech32m("uep", 0x02 || networkTag(4) || keyHash(31)); 68 chars
addressFromSpendKey(networkId, publicKey): string
decodeAccountAddress(address, expectedNetworkId?): { ok: true, version: 2, networkTag, accountId } | { ok: false, code, message }
parseAccountAddress(address, networkId): Fr                   // throws "<code>: message"
addressNetworkTag(networkId): string                          // SHA-256("UEP-ADDR-NETWORK-v2\n" || networkId)[0..4], hex
isValidBech32m(s), bech32mEncode(hrp, bytes)                  // BIP-350 helpers
UepAddressV2: AddressEncoder                                  // encode / decode(address, expectedNetworkId?)
UepAddressV1                                                  // deprecated: encode throws ADDRESS_LEGACY_V1, decode returns null
```

Decode error codes:

| Code | Meaning |
|---|---|
| `ADDRESS_CHECKSUM` | Bech32m checksum mismatch (typo, substitution, transposition). |
| `ADDRESS_VERSION` | Unsupported version byte, or encoding a non-key-derived id. |
| `ADDRESS_NETWORK` | Network tag of another network. |
| `ADDRESS_HRP` | Prefix other than `uep`. |
| `ADDRESS_LENGTH` | Wrong overall or payload length. |
| `ADDRESS_FORMAT` | Mixed case, invalid character, or missing separator. |
| `ADDRESS_LEGACY_V1` | `uep:<network>:<hex>` addresses from v0.4.4 and earlier. |

`DecodedAddress` is now `{ version, networkTag, accountId }`; `networkId` can no longer be read back from an address, only checked against it.

## Ledger: `src/testnet/ledger.ts`

```ts
ledger.addressOf(account): string                      // v2 address on this ledger's network
ledger.resolveAccount(accountOrAddress): Fr            // v2 address string or key-derived Fr; throws ADDRESS_*
ledger.faucet(accountOrAddress, asset, amount)         // throws FAUCET_ACCOUNT_INVALID for legacy / invalid accounts
ledger.prepareSpend(secrets, recipientOrAddress, asset, amount)   // INVALID_ADDRESS for bad addresses
```

**Removed:** `ledger.registerSpendKey()`, `ledger.spendKeyOf()` and `ledger.spendKeys`.

- Spends are verified without a registry. `senderAuth.publicKey` must hash to `senderId` and to every input note's owner (`OWNER_KEY`), and must have signed the envelope (`SENDER_AUTH`).
- Sender and recipient must be key-derived ids (`INVALID_PARTICIPANTS` in `checkSpendShape`).
- New `SubmitError` codes: `OWNER_KEY`, `INVALID_ADDRESS`.

### Snapshots (format version 5)

`SNAPSHOT_FORMAT_VERSION = 5`. The `spendKeys` field is removed, and a snapshot that carries one is rejected (`INVALID_SNAPSHOT_SPEND_KEY`). v3/v4 snapshots are rejected (`INVALID_SNAPSHOT_VERSION`).

New restore checks:

- `INVALID_SNAPSHOT_NOTE_OWNER`: a note owner is not a key-derived account id.
- `INVALID_SNAPSHOT_OWNER_KEY`: a committed spend's revealed key does not hash to its sender or input-note owner.
- `INVALID_SNAPSHOT_TX_SENDER`: the signature is missing or does not verify.
- `INVALID_SNAPSHOT_PENDING: OWNER_KEY`: the same rule applied to pending entries.

## Marketplace: `src/marketplace/marketplace.ts`

```ts
new DigitalServicesMarketplace({
  ...,
  ledgerNetworkId?: string,                       // network of address-named identities (default "uep-testnet-1")
  reservationDeposit?: bigint,                    // now >= MIN_RESERVATION_DEPOSIT (1n) ...
  testOnlyAllowZeroReservationDeposit?: boolean,  // ... unless this TEST-ONLY flag permits exactly 0n
})
marketplace.ledgerAccountOf(identityId): Fr | undefined
```

- `registerIdentity(identityId, publicKey)`: an id that is a v2 address (`uep1…`) must be canonical lowercase for `ledgerNetworkId`, and the key must be the one the address commits to. Errors: `IDENTITY_ADDRESS_INVALID: <ADDRESS_CODE>` and `IDENTITY_ADDRESS_KEY_MISMATCH`. Legacy `uep:<network>:<hex>` ids are refused. Plain names are unchanged.
- `reservationDeposit` from 0 to below 1 throws `RESERVATION_DEPOSIT_BELOW_MINIMUM` unless `testOnlyAllowZeroReservationDeposit: true` (UEP-D03). Negative values still throw `INVALID_RESERVATION_LIMIT`.
- `fundOrder(orderId, amount, auth)` is unchanged since v0.4.4. Only the buyer's `fund` signature is accepted: unsigned calls get `ACTOR_SIGNATURE_REQUIRED`, other parties `ORDER_ACCESS_FORBIDDEN`, wrong keys `ACTOR_SIGNATURE_INVALID` (UEP-D02).
- `src/marketplace/testkit.ts`: `enrollAccountIdentity(m, secrets, credit?)` registers a ledger identity under its address with its spend key.

IoT/M2M providers are marketplace identities, so the same address rule applies to them. IoT signatures are unchanged.

# v0.4.4

The v0.4.4 signatures below are superseded where the v0.4.5 section above says so. In particular the spend-key registry (`registerSpendKey`, `spendKeyOf`, `spendKeys`) is removed and the snapshot format is 5.

## Fees: `src/core/fee.ts`, `src/marketplace/economy.ts`

```ts
creatorFee(amount): bigint                 // 0 for 0; else max(MIN_PROTOCOL_FEE = 1, floor(amount * 0.1%))
calculateMarketplaceFee(gross, bps = 300)  // 0 for 0 or bps = 0; else max(MIN_MARKETPLACE_FEE = 1, floor(gross * bps / 10_000)), capped at gross
```

The documented rates (0.1% protocol, 3% Marketplace) are unchanged above the floor (1,000 units and about 34 units respectively). Envelopes with `fee = 0` on a positive amount are now rejected.

## Sender spend keys: `src/core/spend-key.ts` (new)

```ts
deriveSpendKey(secret, salt): { privateKey, publicKeyHex }        // deterministic Ed25519 key, never leaves the holder
senderAuthMessage(tx): string                                      // "UEP-TX-SENDER-v1" over networkId, domainId, txId, senderId, transactionCommitment
signSenderAuth(tx, secret, salt): { publicKey, signature }
verifySenderAuth(tx, registeredPublicKey): boolean
spendKeyRegistrationMessage(networkId, accountHex), verifySpendKeyRegistration(networkId, reg)
```

## Note-commitment tree: `src/core/note-tree.ts` (new)

```ts
class NoteCommitmentTree {          // depth 32, append-only, keeps every historical root
  append(commitment): number; root(): Fr; size: number; indexOf(commitment)
  prove(commitment): NoteMembershipProof          // { leafIndex, root, siblings[32] } (hex strings)
  verify(commitment, proof, maxAnchorSize?): boolean   // proof root must be a root this tree has had
  sizeAtRoot(rootHex): number | undefined
}
verifyNoteMembership(commitment, proof): boolean  // stateless: links commitment to proof.root
```

## Ledger: `src/testnet/ledger.ts`

```ts
new UepLedger({ ..., maxPendingTransactions?: number })   // default 1024, 1..100_000 (INVALID_MAX_PENDING_TRANSACTIONS)
ledger.registerSpendKey(secrets): SpendKeyRegistration      // idempotent; proves account control
ledger.spendKeyOf(account): string | undefined
ledger.noteCommitmentRoot(): Fr
ledger.noteByCommitment(commitment): Note | undefined
ledger.enqueuePending(tx): SubmitResult                     // validated, bounded, de-duplicated
ledger.queueConflict(tx): SubmitResult                      // was void; now = enqueuePending(tx)
```

- `prepareSpend()` registers the sender's spend key and attaches `tx.senderAuth` and `tx.inputMembership`.
- `submit()` additionally requires a valid membership proof (`MEMBERSHIP_PROOF`) and a valid sender signature by the registered key (`SENDER_AUTH`), also when `requireProof` is disabled. Outputs that already exist are refused (`OUTPUT_BINDING`).
- Offline `submit()` validates before queueing: it returns the validation error, or `NOT_CONNECTED` with a "queued" message.
- Pending validation requires: a registered sender key and valid `senderAuth`; canonical, unspent local input notes whose transported fields match (`NOTE_NOT_MEMBER`, `DOUBLE_SPEND`, `NOTE_OPENING`); `checkSpendShape()` on the canonical inputs; a valid membership proof. Full queue: `PENDING_FULL`; duplicate: `REPLAY`.
- `reconcilePending()` also flags spends sharing an input note as `inConflict`. It still never settles.
- New `SubmitError` codes: `SENDER_AUTH`, `MEMBERSHIP_PROOF`, `PENDING_FULL`.
- `UepTransaction` gains optional `senderAuth` and `inputMembership` (serialized as-is).

### Snapshots (format version 4)

The snapshot adds `noteRoot`, `noteCount`, `spendKeys` and `maxPendingTransactions`. Pending entries that no longer validate are not exported. `SNAPSHOT_FORMAT_VERSION = 4`; v3 snapshots are rejected (`INVALID_SNAPSHOT_VERSION`).

New restore errors:

- `INVALID_SNAPSHOT_NOTE_ROOT`: the rebuilt note tree does not match `noteRoot` / `noteCount`.
- `INVALID_SNAPSHOT_TX_MEMBERSHIP`: a committed spend's proof is missing, wrong, or anchored at a root that does not predate its outputs.
- `INVALID_SNAPSHOT_TX_SENDER`: a committed spend is not signed by the registered spend key.
- `INVALID_SNAPSHOT_SPEND_KEY`: a malformed, duplicate or unproven key registration.
- `INVALID_SNAPSHOT_PENDING`: an over-bound or duplicate queue, or a pending entry that fails validation (the message carries its code).

## Marketplace: `src/marketplace/marketplace.ts`, `src/marketplace/identity.ts`

Every call that reads or changes an order now takes an **`ActorAuth`** instead of an identity string:

```ts
type ActorAuth = { actorId: string; signature: string; issuedAt?: number };
actionMessage({ marketplaceId, action, actorId, target, details }): string   // domain "UEP-MARKETPLACE-ACTION-v1"
signAction({ marketplaceId, action, actorId, target, details }, privateKey): ActorAuth
listingTerms(listingInput), disputeReasonHash(reason)
```

Registered identities sign with their registered key. `adminIdentity` signs with `adminPublicKey` and the arbiter with `settlementArbiterPublicKey`. A plain string throws `ACTOR_SIGNATURE_REQUIRED`; a wrong key throws `ACTOR_SIGNATURE_INVALID`.

| Call (v0.4.4) | action / target / details | Allowed actors |
|---|---|---|
| `publishListing(input, auth)` | `publish` / `input.listingId ?? ""` / `listingTerms(input)` | the registered provider |
| `fundOrder(orderId, amount, auth, idem?)` | `fund` / orderId / `{ amount }` | buyer |
| `deliver(orderId, auth, bytes, idem?)`, `deliverWithExpectedHash(orderId, auth, bytes, hash, idem?)` | `deliver` / orderId / `{ deliveryHash }` | provider |
| `settle(orderId, auth)` | `settle` / orderId | buyer; provider after `deliveryDisputeWindowMs` without a dispute; arbiter. Never the admin |
| `openDispute(orderId, auth, reason)` | `dispute` / orderId / `{ reasonHash }` | buyer, within the window, arbiter configured |
| `resolveDispute(orderId, auth, { outcome, providerAmount? })` | `resolve` / orderId / `{ outcome, providerAmount }` | arbiter |
| `refundBuyer(orderId, auth)` | `refund` / orderId | provider |
| `cancel(orderId, auth, reason?)` | `cancel` / orderId | buyer, provider, admin |
| `expire(orderId, auth)` | `expire` / orderId | buyer, provider, admin |
| `getOrder(orderId, auth)` | `read` / orderId / `{ issuedAt }` | buyer, provider, admin; arbiter once disputed |
| `listOrders(auth)`, `listOrdersPage(offset, limit, auth)` | `list` / `"orders"` / `{ issuedAt }` | own orders; admin sees all |
| `recordSellerReview({ orderId, rating }, auth)` | `review` / orderId / `{ rating }` | buyer |

- Read and list authorizations must carry `issuedAt` within `readAuthorizationTtlMs` (default 5 min) of the marketplace clock (`ACTOR_AUTH_ISSUED_AT_REQUIRED`, `ACTOR_AUTH_EXPIRED`). `clock()` exposes that clock.
- **Disputes.** `OrderStatus` adds `DISPUTED` and `REFUNDED`. Outcomes:
  - `RELEASE`: normal settlement.
  - `REFUND_BUYER`: gross + gas back to the buyer; the paymaster sponsorship is released; no fee.
  - `SPLIT`: `0 < providerAmount < gross`. The provider gets `providerAmount − fee(providerAmount)`, the treasury `fee(providerAmount)`, gas is captured, and the buyer gets `gross − providerAmount`. `0` → refund, `gross` → release.
  - A buyer `settle()` on a disputed order withdraws the dispute.
  - After `disputeResolutionWindowMs` (default 7 days) any party's `settle()` applies `disputeTimeoutOutcome` (default `REFUND_BUYER`).
  - `SettlementRecord` adds `outcome` and `buyerRefund`. `ServiceOrder` adds `deliveredAt`, `disputedAt`, `disputeReasonHash`, `disputeDeadline`, `disputeOutcome` and `buyerRefund`.
- Errors: `DISPUTE_NOT_AUTHORIZED`, `DISPUTE_ARBITER_NOT_CONFIGURED`, `ORDER_NOT_DISPUTABLE`, `DISPUTE_WINDOW_CLOSED`, `DISPUTE_PENDING`, `DISPUTE_NOT_OPEN`, `DISPUTE_RESOLUTION_NOT_AUTHORIZED`, `DISPUTE_OUTCOME_INVALID`, `DISPUTE_SPLIT_INVALID`, `REFUND_NOT_AUTHORIZED`, `ORDER_NOT_REFUNDABLE`.
- **Configuration:**
  - `adminPublicKey`: without it no admin action is possible (`ADMIN_NOT_CONFIGURED`). `adminAuthorizer` is an optional extra gate.
  - `settlementArbiterPublicKey`: required with `settlementArbiterId` (`ARBITER_PUBLIC_KEY_REQUIRED`).
  - `disputeResolutionWindowMs`, `disputeTimeoutOutcome`, `readAuthorizationTtlMs`.
- **Reserved identities:** `"marketplace-admin"`, `"marketplace-system"` (`RESERVED_IDENTITIES`), the admin id and the arbiter id.
- **Other new members:**
  - `authenticateActor(auth, action, target, details)`: verification only.
  - `authorityPublicKeys()`, `orderCount()`.
  - `attachCategoryService(category, { settlementGuard })`: once per category. It returns a read capability limited to that category's orders, and its guard runs on the normal release paths.
  - `IOT_M2M` orders cannot be released normally without an attached guard (`IOT_SETTLEMENT_GUARD_REQUIRED`).
- `cancellationMessage()` / `signCancellation()` now produce a `cancel` action signature. Pass it as `{ actorId: buyerId, signature }`.
- `MARKETPLACE_VERSION = "0.4"`.

## IoT/M2M: `src/service/iot-m2m.ts`

```ts
registerProvider({ providerId, displayName }, auth)            // registered marketplace identity; "iot-provider-register" / providerId / { displayName }
registerMachine({ machineId, providerId, serviceType, model, endpointRef, publicKeyHex }, auth)   // publicKeyHex required; "iot-machine-register" / machineId / iotMachineTerms(input)
deactivateProvider(providerId, adminAuth)                      // "iot-provider-deactivate"
deactivateMachine(machineId, adminOrProviderAuth)              // "iot-machine-deactivate"
holdAmount(requestId): bigint; hold(requestId, buyerFundAuth)
simulateExecution(requestId, measurements, observedAt?, machinePrivateKey, unitsDelivered?)   // signer required
deliverTelemetry(requestId, telemetry, providerDeliverAuth)    // deliveryHash = iotTelemetryDeliveryHash(telemetry)
verifyTelemetry(requestId, telemetry): IoTVerification         // adds unitsDelivered, fullyDelivered, deliveryHash; authentication is always "ED25519"
settle(requestId, settleAuth); serviceStatus(requestId, readAuth)
getRequest / getContract / getTelemetry(id, readAuth); orderIdOf(requestId)
```

- The unsigned `SIMULATED` mode is removed: machines without a key cannot be registered, and unsigned or wrong-key telemetry is rejected (`IOT_TELEMETRY_SIGNATURE_INVALID`, `IOT_SIGNED_TELEMETRY_REQUIRED`).
- Sequence and nonce replay checks are unchanged.
- `IoTTelemetry` adds `unitsDelivered` (it is part of the signed payload). Verification only accepts the report delivered to the order (`IOT_TELEMETRY_NOT_DELIVERED`).
- The marketplace releases an IoT order through `settle()` only with verified telemetry for that delivery reporting the full quantity: `IOT_VERIFICATION_REQUIRED`, `IOT_VERIFIED_TELEMETRY_REQUIRED`, `IOT_USAGE_SHORTFALL`. A shortfall goes to a dispute. `serviceStatus().verifiedUsageAmount` is the provider share for a SPLIT.
- `IOT_M2M_VERSION = "0.3"`.

## Test helpers

- `src/marketplace/testkit.ts`: `createTestAuthority`, `act`, `readAuth`, `listAuth`, `publishAs`, `fund`, `deliver`, `deliverWithExpectedHash`, `settle`, `getOrder`, `listOrders`, `cancel`, `expire`, `review`, `disputeAs`, `resolveAs`, `refundAs`, plus the v0.4.3 helpers.
- `src/service/iot-testkit.ts` (new): `registerProviderAs`, `registerMachineAs`, `requestAs`, `holdAs`, `simulateAs`, `deliverTelemetryAs`, `settleIoTAs`, `statusAs`.

These helpers are for tests and simulations only.

# v0.4.3

The v0.4.3 signatures below are superseded where the v0.4.4 section above says so (for example `fundOrder`, `cancel`, `expire`, `getOrder` and the IoT calls now take an `ActorAuth`).

## Ed25519 helpers: `src/core/ed25519.ts` (new)

Built on `node:crypto`; no third-party dependency. Public keys are exchanged as hex SPKI DER (`publicKeyHex`). Raw 32-byte hex, PEM and `KeyObject` are also accepted.

```ts
generateEd25519KeyPair(): { publicKey: KeyObject; privateKey: KeyObject; publicKeyHex: string }
publicKeyHexOf(key: PublicKeyLike): string
toPublicKey(key: PublicKeyLike): KeyObject
toPrivateKey(key: PrivateKeyLike): KeyObject
signEd25519(message: string | Uint8Array, privateKey: PrivateKeyLike): string      // hex signature
verifyEd25519(message: string | Uint8Array, signatureHex: string, publicKey: PublicKeyLike): boolean
stableStringify(value: unknown): string   // canonical JSON (sorted keys, bigint as "<n>n")
```

## Ledger: `src/testnet/ledger.ts`

### Constructor

```ts
new UepLedger({
  networkId, domainId, connected, allowFaucet,
  snapshotSigningKeys?: PrivateKeyLike[],     // default: one ephemeral key (1-of-1); [] = verify-only node
  faucetSigningKey?: PrivateKeyLike | null,   // default: ephemeral key if allowFaucet; must differ from every snapshot key
})
```

- **Removed:** `snapshotAuthoritySecret`. Passing it throws `SNAPSHOT_SECRET_UNSUPPORTED`.
- `FAUCET_KEY_NOT_DISTINCT`: the faucet key equals a snapshot key. `SNAPSHOT_SIGNING_KEYS_DUPLICATE`: the same snapshot key is passed twice.
- `ledger.snapshotAuthorityPublicKeys(): string[]` and `ledger.faucetPublicKey(): string | undefined` return the public keys to hand to verifiers.
- `ledger.faucet(account, assetId, amount)` now also appends a signed `MintRecord` to `ledger.mints`. It throws `FAUCET_KEY_REQUIRED` without a faucet key and `FAUCET_AMOUNT_INVALID` for a non-positive or out-of-range amount.

### Snapshots (format version 3)

```ts
ledger.snapshot(): UepLedgerSnapshot          // signs with every snapshot key held; advances the chain
ledger.snapshotPayload()                      // next unsigned payload (does not advance)
ledger.lastCheckpoint(): { sequence, snapshotHash }
```

`UepLedgerSnapshot` adds `formatVersion: 3`, `sequence`, `prevSnapshotHash` (64 zeros for the first snapshot), `mints: MintRecord[]`, `snapshotHash` and `signatures: { publicKey, signature }[]`. **Removed:** `integrity` and the self-declared `supply`; supply is derived from the signed mints.

Module helpers:

```ts
snapshotHash(snapshot): string                              // SHA-256 over domain tag + canonical payload
checkpointOf(snapshot): SnapshotCheckpoint                  // { sequence, snapshotHash, txCount, txChainHash, mintCount, mintChainHash }
signSnapshot(snapshotOrPayload, privateKeys): UepLedgerSnapshot   // authority tooling: (re)sign
cosignSnapshot(snapshot, privateKey): UepLedgerSnapshot     // add one co-signature (k-of-n)
mintMessage(mintWithoutSignature): string                   // canonical message signed by the faucet key
GENESIS_SNAPSHOT_HASH, SNAPSHOT_FORMAT_VERSION (= 3)
```

**Removed:** `signSnapshotPayload()`.

### Restore

```ts
UepLedger.restore(snapshot, trust: SnapshotTrust, keys?: LedgerSigningKeys): UepLedger
UepLedger.restoreChain(snapshots: UepLedgerSnapshot[], trust: SnapshotTrust, keys?: LedgerSigningKeys): UepLedger

type SnapshotTrust = {
  authorities: PublicKeyLike[];        // n snapshot authority public keys
  threshold?: number;                  // k (default 1)
  faucetPublicKeys?: PublicKeyLike[];  // required if the snapshot has mints; must not overlap authorities
  previousSnapshotHash?: string;       // snapshot must directly follow this hash
  checkpoint?: SnapshotCheckpoint;     // snapshot must equal or extend this checkpoint
};
type LedgerSigningKeys = { snapshotSigningKeys?: PrivateKeyLike[]; faucetSigningKey?: PrivateKeyLike };
```

- Previously `restore(snapshot, snapshotAuthoritySecret)`.
- Verifiers pass only public keys. A ledger restored without `keys` cannot sign snapshots (`SNAPSHOT_SIGNING_KEY_REQUIRED`) or mint (`FAUCET_KEY_REQUIRED`). Supplied keys must belong to the trust anchors (`SNAPSHOT_SIGNING_KEY_NOT_TRUSTED`, `FAUCET_KEY_NOT_TRUSTED`).
- New errors:
  - `INVALID_SNAPSHOT_VERSION`: format 1 or 2 is no longer supported.
  - `INVALID_SNAPSHOT_TRUST`: bad or duplicate keys, a threshold out of range, or a faucet key that is also an authority.
  - `INVALID_SNAPSHOT_HASH`: `snapshotHash` does not match the content.
  - `INVALID_SNAPSHOT_SIGNATURE`: a listed authority's signature does not verify.
  - `INVALID_SNAPSHOT_THRESHOLD`: fewer than `k` distinct valid listed signers. Duplicates count once; unknown keys are ignored.
  - `INVALID_SNAPSHOT_CHAIN`: wrong predecessor, a sequence gap or reorder, a rollback behind the checkpoint, or a conflict with it.
  - `INVALID_SNAPSHOT_HISTORY`: the transaction or mint history diverges from the checkpoint prefix.
  - `INVALID_SNAPSHOT_MINT_KEY`: the snapshot has mints but no faucet key was supplied.
  - `INVALID_SNAPSHOT_MINT_SIGNATURE`: a mint is unsigned or signed by an untrusted key.
  - `INVALID_SNAPSHOT_MINT_SHAPE`, `INVALID_SNAPSHOT_MINT_NOTE`, `INVALID_SNAPSHOT_MINT_DUPLICATE`.
  - `INVALID_SNAPSHOT_UNMINTED_NOTE`: a note is neither a signed mint nor a transaction output.
  - All v0.4.2 `INVALID_SNAPSHOT_*` invariant errors still apply.

## Marketplace: `src/marketplace/marketplace.ts`, `src/marketplace/identity.ts`

### Configuration (new options)

```ts
new DigitalServicesMarketplace({
  ...,
  cancellationGraceMs?: number,                // default 120_000 (2 min)
  marketplaceId?: string,                      // signature domain, default "uep-marketplace-testnet"
  reservationTtlMs?: number,                   // default 600_000 (10 min), must be > 0
  maxActiveReservationsPerIdentity?: number,   // default 8
  reservationDeposit?: bigint, reservationDepositBps?: number,   // unchanged (default 1%, min 1 unit)
})
```

### Identities and balances (new)

```ts
registerIdentity(identityId: string, publicKey: PublicKeyLike): RegisteredIdentity   // first-come, immutable
isIdentityRegistered(identityId): boolean
registeredIdentity(identityId): RegisteredIdentity
creditAccount(identityId, asset, amount): bigint     // testnet funding rail; registered identities only
availableBalance(asset, identityId): bigint
lockedDeposit(asset, identityId): bigint
valueAccounting(asset): ValueAccounting              // credited == available + locked + held + fees + gas
```

Errors: `IDENTITY_NOT_REGISTERED`, `IDENTITY_ALREADY_REGISTERED`, `RESERVED_IDENTITY`, `IDENTITY_PUBLIC_KEY_INVALID`, `INVALID_CREDIT_AMOUNT`.

Client helpers (`identity.ts`): `createMarketplaceIdentity(id)`, `reservationMessage()`, `signReservation({ marketplaceId, listingId, buyerId, quantity, idempotencyKey, orderId?, gasQuoteId? }, privateKey)`, `cancellationMessage()` and `signCancellation({ marketplaceId, orderId, buyerId }, privateKey)`.

### Order lifecycle

```ts
reserve({ listingId, buyerId, quantity, idempotencyKey, signature, orderId?, gasQuote? }): ServiceOrder
acceptOrder(sameInput): ServiceOrder                    // alias of reserve()
assertReservationAuthorized(sameInput): void
fundOrder(orderId, amount /* = order.fundingDue */, idempotencyKey?): ServiceOrder
cancel(orderId, actorId, options?: string | { reason?: string; signature?: string }): ServiceOrder
expire(orderId, actorId): ServiceOrder                  // only after the TTL
reservationDepositFor(grossAmount, gasFee = 0n): bigint // capped at grossAmount + gasFee
```

- `acceptOrder`/`reserve` now **require** `idempotencyKey` and `signature`. The buyer must be registered, and the deposit is locked from `availableBalance` (`INSUFFICIENT_FUNDS_FOR_DEPOSIT`). Other errors: `RESERVATION_SIGNATURE_INVALID`, `IDEMPOTENCY_KEY_REQUIRED`, `RESERVATION_LIMIT_REACHED`, and `ORDER_ID_CONFLICT`, which replaces silently returning an existing order.
- A replayed signed request returns the same order. It never locks a second deposit.
- `fundOrder` amount is now `grossAmount + gasFee − reservationDeposit` (`order.fundingDue`), previously `grossAmount + gasFee + reservationDeposit`. It is debited from the buyer's balance (`INSUFFICIENT_FUNDS`). `heldAmount` is then `grossAmount + gasFee`.
- A buyer `cancel` requires `{ signature }` (`BUYER_SIGNATURE_REQUIRED`, `CANCELLATION_SIGNATURE_INVALID`). Within `cancellationGraceMs` of reservation the deposit is refunded; afterwards it is forfeited to the provider. Provider or authorized-admin cancellation refunds the buyer in full.
- Expiry: an unfunded reservation forfeits the deposit to the provider, and a funded undelivered order is refunded in full. `expire()` before the TTL throws `RESERVATION_NOT_EXPIRED`.
- At settlement the provider's net payout is credited to its `availableBalance`.
- `ServiceOrder` adds `fundingDue`, `depositLocked` and `depositOutcome` (`APPLIED_TO_PAYMENT` | `REFUNDED` | `FORFEITED_TO_PROVIDER`).
- `checkoutQuote()`: `buyerTotal` is now `grossAmount + gasFee` because the deposit is included. It adds `dueAtFunding` and `cancellationGraceMs`.

## IoT/M2M: `src/service/iot-m2m.ts`

```ts
requestService({ buyerId, listingId, machineId, quantity, idempotencyKey, authorization, requestId? })
hold(requestId)   // funds grossAmount + gasFee − reservationDeposit
```

`idempotencyKey` and `authorization` are now **required**. `authorization` is the buyer's `signReservation({ marketplaceId, listingId, buyerId, quantity, idempotencyKey }, privateKey)`, and the buyer must be a registered, funded marketplace identity.

## Test helpers: `src/marketplace/testkit.ts` (new)

`enrollIdentity`, `reserveAs`, `cancelAsBuyer` and `iotAuthorization` are for tests and simulations only.
