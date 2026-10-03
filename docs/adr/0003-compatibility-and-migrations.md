# ADR 0003: Compatibility, snapshot migrations and deprecation shims

- Status: accepted (v0.5.0).
- Scope: ledger snapshots, the public TypeScript API, the HTTP adapter and asset ids. The policy itself is [`docs/COMPATIBILITY.md`](../COMPATIBILITY.md).
- Code:
  - `src/testnet/snapshot-migrations.ts` (registry), `src/testnet/snapshot-json.ts` (JSON codec), `src/core/deprecation.ts`;
  - `LEGACY_ASSET_ID_ALIASES` in `src/core/assets.ts`, `legacyMsToHeight` in `src/core/height.ts`, `src/service/height-producer.ts`;
  - `scripts/check-snapshot-compat.ts`, `scripts/fixtures/generate-snapshot-fixture.ts`, fixtures in `src/testnet/fixtures/snapshots/`.
- Tests: `src/testnet/snapshot-fixtures.test.ts`, `src/testnet/snapshot-migration-chain.test.ts`, `src/testnet/snapshot-compat-check.test.ts`, `src/service/compat-shims.test.ts`.

## Context

v0.5.0 changed several things that broke existing users:

- the snapshot format (6 → 7, block height; ADR 0002);
- the asset ids (`asset:test:eur` → `uep-test/teur`);
- the unit of every time value (Unix ms → block height).

Before this ADR a restore of format 6 failed with `INVALID_SNAPSHOT_VERSION`, old asset ids failed with `ASSET_ID_INVALID`, and several old options threw `CLOCK_CONFIG_CONFLICT` or silently changed meaning. Each later format change would have broken every stored snapshot again.

## Decision

1. **A migration registry, chained one format at a time.** `SNAPSHOT_MIGRATIONS` is an append-only list of steps `{ from: N, to: N + 1, derivation, fixtures, migrate }`. `restore()` checks hash, signatures, chain link and checkpoint on the snapshot as signed, then applies the steps in order, then runs every invariant on the result. A step is a pure function of the payload. It never touches transactions, mints or notes, because those bytes are signed and hashed. A future format 8 (for example the ledger consuming the asset registry manifest) adds one step 7 → 8. The existing steps are not edited.
2. **Derivations instead of guesses.** A field that a format did not have is derived in a documented way, without a clock and without keys.
   - Step 6 → 7 sets `height = 0` and `lastReconcileAt = 0`, and sets `windowHeights = ceil(windowMs / 5000)`.
   - We did not derive the height from `sequence`. A snapshot sequence counts snapshots, not blocks, and implying otherwise would mislead.
3. **The signed snapshot stays the anchor.** The restored ledger keeps the hash of the snapshot it was restored from. Its next snapshot (format 7) links to it, so a chain crosses the format change without re-signing.
4. **Golden fixtures from the historical releases.** Fixtures are generated once by the code of the release that wrote the format (`git archive <commit>`) and committed. Every supported format and every step needs at least one. The fixture test loads all of them on every run.
5. **A CI gate.** `npm run check:snapshot-compat` fails when the format number, the registry, the fixtures and the recorded payload shape (`FORMAT.json`) disagree. A shape change without a format bump fails too.
6. **Aliases and shims at the edges.**
   - Old asset ids resolve through a fixed alias table.
   - Old options and fields are converted deterministically before they reach a transition.
   - Old wall-clock values (`x-uep-issued-at` in ms) are mapped to heights only in boundary adapters that already own a clock (the service API and HTTP).
   - Each shim emits a `DeprecationWarning` with a stable code and stays for at least one minor version.
7. **Refuse with a reason when no deterministic conversion exists.** Formats 1–5 use the SHA-256 field hash. Moving them to Poseidon would change every commitment, nullifier, transaction id and root that the spend and mint signatures bind. That needs every owner's key, so these formats are refused with a message that says why. Their fixture checks the refusal.

## Consequences

- Stored format 6 testnet state, including state with the pre-release asset ids, restores and keeps working: balances, chain continuity and new spends.
- Each later format change costs one step, one fixture and a lock update. CI enforces all three.
- Notes minted under an old asset id keep that encoding. Balances by asset id add up both encodings, and a single payment uses one encoding.
- Code that relied on the wall clock inside a transition cannot be made compatible (ADR 0002). The single-node height producer (`HeightProducer`) advances the height from real time instead, outside the transitions. A Marketplace without a height source fails closed (`HEIGHT_SOURCE_REQUIRED`) rather than silently freezing its windows.
- Shims add a small amount of code at the edges. They are listed with their codes in `docs/COMPATIBILITY.md` and can be found with `node --throw-deprecation`.

## Alternatives considered

- **Reject old formats and document re-creation.** This was the earlier behaviour. It is cheap, but every format change breaks every user again.
- **Direct converters from each old format to the latest.** These grow quadratically and each one has to be edited on every change. The chained steps grow linearly.
- **Re-sign migrated snapshots.** This would need the authority keys at restore time and would replace the signed history. Verify-only nodes could no longer restore.
- **Derive `height` from `sequence` or from `lastReconcileAt` ms.** Either would invent a relation between snapshots, wall-clock time and blocks that does not exist.
