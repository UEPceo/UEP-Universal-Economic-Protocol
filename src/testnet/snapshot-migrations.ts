/**
 * Ledger snapshot migration registry (docs/COMPATIBILITY.md, ADR 0003).
 *
 * Each step converts a snapshot payload of format N into format N + 1. Steps
 * are pure functions of the payload: no clock, no external data, no keys.
 * restore() first checks the hash, the authority signatures and the chain
 * links of the snapshot exactly as it was signed, then applies the steps in
 * order, then runs every restore invariant on the migrated payload. The
 * restored ledger keeps the hash of the signed snapshot, so its next snapshot
 * links to it.
 *
 * Steps never rewrite transactions, mints or notes: their hashes and
 * signatures bind those bytes, and checkpoints hash the transaction and mint
 * history.
 *
 * Adding a format F + 1: bump SNAPSHOT_FORMAT_VERSION in ledger.ts, append the
 * step F -> F + 1 here with its golden fixture(s) of format F, and add a
 * golden fixture of format F + 1. `npm run check:snapshot-compat` fails until
 * all three exist.
 */
import { heightsForMs } from "../core/height.ts";
import { resolveAssetIdAlias, isLegacyAssetIdAlias } from "../core/assets.ts";

export type SnapshotPayloadRecord = Record<string, unknown>;

export type SnapshotMigrationStep = {
  from: number;
  to: number;
  title: string;
  /** How every new or changed field is derived (documentation, also shown by tests). */
  derivation: readonly string[];
  /** Golden fixtures of format `from` (paths relative to src/testnet/fixtures/snapshots/). */
  fixtures: readonly string[];
  migrate(payload: SnapshotPayloadRecord): SnapshotPayloadRecord;
};

function fail(step: string, detail: string): never {
  throw new Error(`${step}: ${detail}`);
}

/** Copy of a per-asset record with legacy asset ids resolved; the namespaced entry wins on a collision. */
function canonicalAssetKeys(record: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!record || typeof record !== "object") return out;
  const entries = Object.entries(record as Record<string, unknown>);
  for (const [k, v] of entries) if (!isLegacyAssetIdAlias(k)) out[k] = v;
  for (const [k, v] of entries) if (isLegacyAssetIdAlias(k)) { const c = resolveAssetIdAlias(k); if (!(c in out)) out[c] = v; }
  return out;
}

const step6to7: SnapshotMigrationStep = {
  from: 6,
  to: 7,
  title: "block height (ADR 0002) and namespaced policy asset ids",
  derivation: [
    "height = 0: format 6 had no block height; the restored ledger starts its height-based time at 0 and advances from there",
    "lastReconcileAt = 0: format 6 stored a wall-clock Unix-ms value, which cannot be turned into a height without a clock; it is informational only",
    "policy.windowHeights = ceil(policy.windowMs / 5000) (60,000 ms -> 12 heights); policy.windowMs is removed",
    "policy.assetTier and policy.assetLimits keys: pre-v0.5.0 asset ids are replaced by their namespaced ids (the namespaced entry wins if both exist)",
    "transactions, mints, notes, state and roots are unchanged; transaction createdAt values stay as historical metadata (not used by any rule)",
  ],
  fixtures: ["v6-main-020e6ce.json", "v6-v0.5.0-8d774d3.json"],
  migrate(p) {
    const name = "MIGRATION_6_7";
    if (p.formatVersion !== 6) fail(name, "expected formatVersion 6");
    if (!Number.isSafeInteger(p.lastReconcileAt) || (p.lastReconcileAt as number) < 0) fail(name, "lastReconcileAt must be a non-negative integer");
    if ("height" in p) fail(name, "format 6 has no height field");
    const policy = p.policy && typeof p.policy === "object" ? { ...(p.policy as Record<string, unknown>) } : fail(name, "policy missing");
    if (policy.windowHeights === undefined) {
      const ms = policy.windowMs;
      if (!Number.isSafeInteger(ms) || (ms as number) <= 0) fail(name, "policy.windowMs must be a positive integer");
      policy.windowHeights = heightsForMs(ms as number);
    }
    delete policy.windowMs;
    policy.assetTier = canonicalAssetKeys(policy.assetTier);
    policy.assetLimits = canonicalAssetKeys(policy.assetLimits);
    return { ...p, formatVersion: 7, policy, lastReconcileAt: 0, height: 0 };
  },
};

const step7to8: SnapshotMigrationStep = {
  from: 7,
  to: 8,
  title: "asset registry binding (ADR 0001) and settlement anchors",
  derivation: [
    "assetRegistry = null: format 7 ledgers enforced only the network asset templates; a restore may adopt a trusted registry (trust.assetRegistry), and every note, mint and transaction asset is then checked against it",
    "settlementAnchors = []: no Marketplace settlement was anchored in consensus state before v0.5.3",
    "every other field is unchanged",
  ],
  fixtures: ["v7-v0.5.0-evidence-time.json", "v7-v0.5.2-7173d37.json"],
  migrate(p) {
    const name = "MIGRATION_7_8";
    if (p.formatVersion !== 7) fail(name, "expected formatVersion 7");
    if ("assetRegistry" in p || "settlementAnchors" in p) fail(name, "format 7 has no assetRegistry or settlementAnchors field");
    return { ...p, formatVersion: 8, assetRegistry: null, settlementAnchors: [] };
  },
};

const step8to9: SnapshotMigrationStep = {
  from: 8,
  to: 9,
  title: "height-advance record (the 12-block catch-up cap as a state invariant)",
  derivation: [
    "ticks = { count: ceil(height / 12), maxBlocksPerTick: 12, mode: \"capped\" }: format 8 did not record producer ticks; the count is the smallest one consistent with the cap. Checkpoints of format 8 snapshots carry no tick count, so the per-tick growth check starts at the first format 9 snapshot",
    "every other field is unchanged",
  ],
  fixtures: ["v8-v0.5.3.json"],
  migrate(p) {
    const name = "MIGRATION_8_9";
    if (p.formatVersion !== 8) fail(name, "expected formatVersion 8");
    if ("ticks" in p) fail(name, "format 8 has no ticks field");
    const height = p.height;
    if (typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) fail(name, "height must be a non-negative integer");
    const out: SnapshotPayloadRecord = {};
    // Same key order as a native format 9 payload (ticks after height); the hash is over canonical JSON either way.
    for (const [k, v] of Object.entries(p)) {
      out[k] = v;
      if (k === "height") out.ticks = { count: Math.ceil((height as number) / 12), maxBlocksPerTick: 12, mode: "capped" };
    }
    out.formatVersion = 9;
    return out;
  },
};

/** Registered steps, in order. Append only. */
export const SNAPSHOT_MIGRATIONS: readonly SnapshotMigrationStep[] = Object.freeze([step6to7, step7to8, step8to9]);

/** Oldest format that can still be restored (through migration). */
export const OLDEST_MIGRATABLE_SNAPSHOT_FORMAT = 6;

const HASH_CHANGE =
  "the SHA-256 field reference hash; format 6 moved to the Poseidon BN254 protocol hash, which changes note commitments, nullifiers, transaction ids and every root, and the spend signatures, mint signatures and checkpoints bind those values. A conversion would need every owner's keys and the mint keys, so this testnet state has to be re-created";

/** Formats that cannot be migrated, with the reason (shown in INVALID_SNAPSHOT_VERSION). */
export const UNMIGRATABLE_SNAPSHOT_FORMATS: Readonly<Record<number, string>> = Object.freeze({
  1: `snapshot format 1 (before v0.4.3) carries no authority signatures and uses ${HASH_CHANGE}`,
  2: `snapshot format 2 (before v0.4.3) carries no Ed25519 authority signatures and uses ${HASH_CHANGE}`,
  3: `snapshot format 3 (v0.4.3) has no note-commitment tree and uses ${HASH_CHANGE}`,
  4: `snapshot format 4 (v0.4.4) uses registry-based spend keys instead of key-derived accounts and uses ${HASH_CHANGE}`,
  5: `snapshot format 5 (v0.4.5 - v0.4.7) uses ${HASH_CHANGE}`,
});

/** Format produced by the last step (equals SNAPSHOT_FORMAT_VERSION; checked by tests and check:snapshot-compat). */
export function latestSnapshotFormat(): number {
  return SNAPSHOT_MIGRATIONS.length ? SNAPSHOT_MIGRATIONS[SNAPSHOT_MIGRATIONS.length - 1]!.to : OLDEST_MIGRATABLE_SNAPSHOT_FORMAT;
}

export type SnapshotFormatSupport =
  | { kind: "current"; formatVersion: number }
  | { kind: "migratable"; formatVersion: number; steps: string[] }
  | { kind: "unmigratable"; formatVersion: number; reason: string }
  | { kind: "unknown"; formatVersion: unknown; reason: string };

export function snapshotFormatSupport(formatVersion: unknown): SnapshotFormatSupport {
  const current = latestSnapshotFormat();
  if (!Number.isSafeInteger(formatVersion)) return { kind: "unknown", formatVersion, reason: `snapshot formatVersion ${String(formatVersion)} is not an integer` };
  const v = formatVersion as number;
  if (v === current) return { kind: "current", formatVersion: v };
  if (v > current) return { kind: "unknown", formatVersion: v, reason: `snapshot formatVersion ${v} is newer than this release (formats ${OLDEST_MIGRATABLE_SNAPSHOT_FORMAT} to ${current} are supported)` };
  if (v >= OLDEST_MIGRATABLE_SNAPSHOT_FORMAT) return { kind: "migratable", formatVersion: v, steps: SNAPSHOT_MIGRATIONS.filter((s) => s.from >= v).map((s) => `${s.from}->${s.to}`) };
  return { kind: "unmigratable", formatVersion: v, reason: `snapshot formatVersion ${v} is no longer supported: ${UNMIGRATABLE_SNAPSHOT_FORMATS[v] ?? "unknown historical format"}` };
}

/** Apply every step from the payload's format to the current format. Pure; throws `MIGRATION_<from>_<to>: ...`. */
export function migrateSnapshotPayload(payload: SnapshotPayloadRecord): { payload: SnapshotPayloadRecord; steps: string[] } {
  let p = payload;
  const steps: string[] = [];
  const current = latestSnapshotFormat();
  while (p.formatVersion !== current) {
    const step = SNAPSHOT_MIGRATIONS.find((s) => s.from === p.formatVersion);
    if (!step) throw new Error(`MIGRATION_MISSING: no step from format ${String(p.formatVersion)}`);
    p = step.migrate(p);
    if (p.formatVersion !== step.to) throw new Error(`MIGRATION_${step.from}_${step.to}: step produced format ${String(p.formatVersion)}`);
    steps.push(`${step.from}->${step.to}`);
  }
  return { payload: p, steps };
}

/** Structural check of the registry: contiguous steps from the oldest migratable format to `currentFormat`. Returns problems. */
export function migrationRegistryProblems(currentFormat: number): string[] {
  const problems: string[] = [];
  if (latestSnapshotFormat() !== currentFormat) problems.push(`the last migration step produces format ${latestSnapshotFormat()}, but SNAPSHOT_FORMAT_VERSION is ${currentFormat}`);
  for (let f = OLDEST_MIGRATABLE_SNAPSHOT_FORMAT; f < currentFormat; f++) {
    const s = SNAPSHOT_MIGRATIONS.filter((x) => x.from === f);
    if (s.length !== 1) problems.push(`format ${f}: expected exactly one step ${f}->${f + 1}, found ${s.length}`);
    else if (s[0]!.to !== f + 1) problems.push(`format ${f}: step goes to ${s[0]!.to}, expected ${f + 1}`);
    else if (s[0]!.fixtures.length === 0) problems.push(`step ${f}->${f + 1}: no golden fixture of format ${f}`);
  }
  for (let f = 1; f < OLDEST_MIGRATABLE_SNAPSHOT_FORMAT; f++) if (!UNMIGRATABLE_SNAPSHOT_FORMATS[f]) problems.push(`format ${f}: neither migratable nor documented as unmigratable`);
  return problems;
}
