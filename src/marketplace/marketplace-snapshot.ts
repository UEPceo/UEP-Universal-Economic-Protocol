/**
 * Marketplace snapshot (v0.5.3, format 2): persisted settlement receipts.
 * Format 2 adds the networkId and allows v2 (networkId-bound) receipts next
 * to legacy v1 receipts (migration 1 -> 2).
 *
 * Before v0.5.3 the Marketplace kept settlement receipts only in memory, so a
 * restart lost them and nothing stopped a restored process from executing the
 * same settlement id again. Format 1 carries the settlement section: every
 * receipt the settlement engine executed (Marketplace orders and category
 * holds), the RFC 9162 batch root over them and per-asset totals. It is bound
 * to the marketplace id and treasury id and committed by a SHA-256 hash.
 *
 * Scope (documented residual limit): this snapshot persists settlement
 * receipts only. Order, balance, treasury and category state are not part of
 * it yet; a restored Marketplace refuses to re-execute any persisted
 * settlement id and can prove each receipt, but balances must still be
 * re-funded from the external rail.
 *
 * Compatibility follows ADR 0003: MARKETPLACE_SNAPSHOT_MIGRATIONS is an
 * append-only registry of steps N -> N + 1 (pure functions of the payload),
 * every supported format has a golden fixture in
 * src/marketplace/fixtures/snapshots/, and `npm run check:snapshot-compat`
 * also checks this registry and the recorded shape (FORMAT.json).
 * Format 1 is the first persisted Marketplace format: there is no earlier
 * Marketplace snapshot to migrate from (v0.5.2 and before persisted none).
 *
 * Pure: no clock, no keys. The height in the snapshot is the Marketplace
 * height passed in by the caller.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../core/canonical-json.ts";
import { snapshotFromJSON, snapshotToJSON } from "../testnet/snapshot-json.ts";
import { settlementBatch } from "../settlement/batch.ts";
import { isKnownReceiptVersion, verifySettlementReceipt } from "../settlement/engine.ts";
import { type SettlementBatch, type SettlementReceipt } from "../settlement/types.ts";

export const MARKETPLACE_SNAPSHOT_KIND = "uep-marketplace-snapshot" as const;
export const MARKETPLACE_SNAPSHOT_FORMAT_VERSION = 2;
export const OLDEST_MIGRATABLE_MARKETPLACE_SNAPSHOT_FORMAT = 1;
const SNAPSHOT_DOMAIN = "UEP-MARKETPLACE-SNAPSHOT-v1";

export type MarketplaceSettlementSection = {
  /** Format 2: distinct receipt versions present (v2, and legacy v1 receipts restored from older snapshots). */
  receiptVersions: SettlementReceipt["version"][];
  count: number;
  /** RFC 9162 root over receipt hashes, in execution order (null when empty). */
  batchRoot: string | null;
  totals: SettlementBatch["totals"];
  receipts: SettlementReceipt[];
};

export type MarketplaceSnapshotPayload = {
  kind: typeof MARKETPLACE_SNAPSHOT_KIND;
  formatVersion: number;
  marketplaceId: string;
  treasuryId: string;
  /** Format 2: network of the Marketplace (null for a migrated format 1 snapshot). */
  networkId: string | null;
  height: number;
  settlement: MarketplaceSettlementSection;
};

export type MarketplaceSnapshot = MarketplaceSnapshotPayload & { snapshotHash: string };

export type MarketplaceSnapshotMigrationStep = {
  from: number;
  to: number;
  title: string;
  derivation: readonly string[];
  /** Golden fixtures of format `from` (relative to src/marketplace/fixtures/snapshots/). */
  fixtures: readonly string[];
  migrate(payload: Record<string, unknown>): Record<string, unknown>;
};

/** Append-only. */
export const MARKETPLACE_SNAPSHOT_MIGRATIONS: readonly MarketplaceSnapshotMigrationStep[] = Object.freeze([
  {
    from: 1,
    to: 2,
    title: "networkId-bound receipts (v2) next to legacy v1 receipts",
    derivation: [
      "networkId = null: format 1 recorded no network",
      "settlement.receiptVersions = [settlement.receiptVersion]; receiptVersion is removed",
      "receipts are unchanged: legacy v1 receipts keep their hash (inclusion proofs and anchors stay valid) and verify through the v1 alias",
    ],
    fixtures: ["mkt-v1-receipts-v1.json"],
    migrate(p: Record<string, unknown>): Record<string, unknown> {
      if (p.formatVersion !== 1) throw new Error("MARKETPLACE_MIGRATION_1_2: expected format 1");
      const settlement = { ...(p.settlement as Record<string, unknown>) };
      const v = settlement.receiptVersion;
      delete settlement.receiptVersion;
      settlement.receiptVersions = typeof v === "string" ? [v] : [];
      return { ...p, networkId: null, settlement };
    },
  },
]);

/** Registry consistency (same rules as the ledger registry). */
export function marketplaceMigrationRegistryProblems(current = MARKETPLACE_SNAPSHOT_FORMAT_VERSION): string[] {
  const problems: string[] = [];
  for (let v = OLDEST_MIGRATABLE_MARKETPLACE_SNAPSHOT_FORMAT; v < current; v++) {
    const steps = MARKETPLACE_SNAPSHOT_MIGRATIONS.filter((s) => s.from === v);
    if (steps.length !== 1 || steps[0]!.to !== v + 1) problems.push(`marketplace format ${v}: expected exactly one step ${v} -> ${v + 1}`);
  }
  for (const s of MARKETPLACE_SNAPSHOT_MIGRATIONS) {
    if (s.to !== s.from + 1) problems.push(`marketplace step ${s.from}->${s.to}: steps go one format at a time`);
    if (s.to > current) problems.push(`marketplace step ${s.from}->${s.to}: newer than MARKETPLACE_SNAPSHOT_FORMAT_VERSION ${current}`);
    if (s.fixtures.length === 0) problems.push(`marketplace step ${s.from}->${s.to}: no golden fixture`);
  }
  return problems;
}

export function marketplaceSnapshotHash(payload: MarketplaceSnapshotPayload): string {
  return createHash("sha256").update(canonicalJson([SNAPSHOT_DOMAIN, payload])).digest("hex");
}

/** Build a snapshot of the given receipts (execution order). */
export function buildMarketplaceSnapshot(input: { marketplaceId: string; treasuryId: string; networkId: string; height: number; receipts: readonly SettlementReceipt[] }): MarketplaceSnapshot {
  if (!Number.isSafeInteger(input.height) || input.height < 0) throw new Error("MARKETPLACE_SNAPSHOT_HEIGHT_INVALID");
  const receipts = input.receipts.map((r) => ({ ...r }));
  const batch = receipts.length ? settlementBatch(receipts) : undefined;
  const payload: MarketplaceSnapshotPayload = {
    kind: MARKETPLACE_SNAPSHOT_KIND,
    formatVersion: MARKETPLACE_SNAPSHOT_FORMAT_VERSION,
    marketplaceId: input.marketplaceId,
    treasuryId: input.treasuryId,
    networkId: input.networkId,
    height: input.height,
    settlement: {
      receiptVersions: [...new Set(receipts.map((r) => r.version))].sort(),
      count: receipts.length,
      batchRoot: batch?.root ?? null,
      totals: batch?.totals ?? {},
      receipts,
    },
  };
  return { ...payload, snapshotHash: marketplaceSnapshotHash(payload) };
}

/** Apply the registered steps from the snapshot's format up to the current one. */
export function migrateMarketplaceSnapshot(snapshot: Record<string, unknown>): MarketplaceSnapshot {
  if (!snapshot || typeof snapshot !== "object" || snapshot.kind !== MARKETPLACE_SNAPSHOT_KIND) throw new Error("MARKETPLACE_SNAPSHOT_INVALID: kind");
  const from = snapshot.formatVersion;
  if (!Number.isSafeInteger(from)) throw new Error("MARKETPLACE_SNAPSHOT_INVALID: formatVersion");
  if ((from as number) > MARKETPLACE_SNAPSHOT_FORMAT_VERSION) throw new Error(`MARKETPLACE_SNAPSHOT_FORMAT_UNSUPPORTED: format ${from} is newer than ${MARKETPLACE_SNAPSHOT_FORMAT_VERSION}`);
  if ((from as number) < OLDEST_MIGRATABLE_MARKETPLACE_SNAPSHOT_FORMAT) throw new Error(`MARKETPLACE_SNAPSHOT_FORMAT_UNSUPPORTED: format ${from}`);
  // The hash is checked on the snapshot as written, before any step.
  const { snapshotHash, ...payload } = snapshot as unknown as MarketplaceSnapshot;
  if (typeof snapshotHash !== "string" || marketplaceSnapshotHash(payload as MarketplaceSnapshotPayload) !== snapshotHash) throw new Error("MARKETPLACE_SNAPSHOT_HASH_MISMATCH");
  let current: Record<string, unknown> = { ...payload };
  for (let v = from as number; v < MARKETPLACE_SNAPSHOT_FORMAT_VERSION; v++) {
    const step = MARKETPLACE_SNAPSHOT_MIGRATIONS.find((s) => s.from === v)!;
    current = { ...step.migrate(current), formatVersion: v + 1 };
  }
  const migrated = current as unknown as MarketplaceSnapshotPayload;
  return { ...migrated, snapshotHash: marketplaceSnapshotHash(migrated) };
}

/**
 * Verify a (migrated) snapshot: receipt hashes, versions, duplicates, the
 * batch root and totals, and the marketplace / treasury binding.
 */
export function verifyMarketplaceSnapshot(snapshot: MarketplaceSnapshot, expect: { marketplaceId: string; treasuryId: string; networkId?: string }): SettlementReceipt[] {
  if (snapshot.marketplaceId !== expect.marketplaceId) throw new Error("MARKETPLACE_SNAPSHOT_MARKETPLACE_MISMATCH");
  if (snapshot.treasuryId !== expect.treasuryId) throw new Error("MARKETPLACE_SNAPSHOT_TREASURY_MISMATCH");
  if (expect.networkId !== undefined && snapshot.networkId !== null && snapshot.networkId !== expect.networkId) throw new Error("MARKETPLACE_SNAPSHOT_NETWORK_MISMATCH");
  const s = snapshot.settlement;
  if (!s || !Array.isArray(s.receiptVersions) || !s.receiptVersions.every(isKnownReceiptVersion) || !Array.isArray(s.receipts) || s.count !== s.receipts.length) throw new Error("MARKETPLACE_SNAPSHOT_INVALID: settlement");
  for (const r of s.receipts) {
    if (!isKnownReceiptVersion(r.version) || !s.receiptVersions.includes(r.version) || !verifySettlementReceipt(r)) throw new Error("SETTLEMENT_RECEIPT_INVALID");
    if (r.treasuryId !== expect.treasuryId) throw new Error("SETTLEMENT_RECEIPT_TREASURY_MISMATCH");
    if (r.networkId !== undefined && expect.networkId !== undefined && r.networkId !== expect.networkId) throw new Error("SETTLEMENT_RECEIPT_NETWORK_MISMATCH");
  }
  if (s.receipts.length === 0) {
    if (s.batchRoot !== null) throw new Error("MARKETPLACE_SNAPSHOT_BATCH_MISMATCH");
    return [];
  }
  const batch = settlementBatch(s.receipts);
  if (batch.root !== s.batchRoot || canonicalJson(batch.totals) !== canonicalJson(s.totals)) throw new Error("MARKETPLACE_SNAPSHOT_BATCH_MISMATCH");
  return s.receipts.map((r) => ({ ...r }));
}

export function marketplaceSnapshotToJSON(snapshot: MarketplaceSnapshot, space?: number): string {
  return snapshotToJSON(snapshot, space);
}

export function marketplaceSnapshotFromJSON(text: string): MarketplaceSnapshot {
  return snapshotFromJSON<MarketplaceSnapshot>(text);
}

/** Shape recorded in FORMAT.json (top-level, settlement and receipt keys). */
export function marketplaceSnapshotShape(snapshot: MarketplaceSnapshot): { formatVersion: number; payloadKeys: string[]; settlementKeys: string[]; receiptKeys: string[] } {
  const { snapshotHash: _h, ...payload } = snapshot;
  return {
    formatVersion: snapshot.formatVersion,
    payloadKeys: Object.keys(payload).sort(),
    settlementKeys: Object.keys(snapshot.settlement).sort(),
    receiptKeys: Object.keys(snapshot.settlement.receipts[0] ?? {}).sort(),
  };
}
