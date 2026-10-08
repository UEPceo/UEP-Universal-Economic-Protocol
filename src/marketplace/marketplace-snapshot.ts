/**
 * Marketplace snapshot (v0.5.3, format 4): persisted settlement receipts and,
 * since format 4, the full Marketplace state.
 * Format 2 adds the networkId and allows v2 (networkId-bound) receipts next
 * to legacy v1 receipts (migration 1 -> 2).
 * Format 3 (migration 2 -> 3) adds the order-id counter (`orderSequence`), so a
 * restored Marketplace never hands out an order id that already has a
 * receipt, and the list of legacy v1 receipts (`legacyV1SettlementIds`): a v1
 * receipt is accepted only when it came from a migrated format 1 / 2 snapshot.
 * Format 3 snapshots are signed by the Marketplace snapshot key(s) (Ed25519
 * over the snapshot hash); restore requires a trusted signature. Unsigned
 * format 1 / 2 snapshots restore only with `acceptUnsignedLegacySnapshot`.
 *
 * Before v0.5.3 the Marketplace kept settlement receipts only in memory, so a
 * restart lost them and nothing stopped a restored process from executing the
 * same settlement id again. Format 1 carries the settlement section: every
 * receipt the settlement engine executed (Marketplace orders and category
 * holds), the RFC 9162 batch root over them and per-asset totals. It is bound
 * to the marketplace id and treasury id and committed by a SHA-256 hash.
 *
 * Format 4 (migration 3 -> 4) adds the `state` section: balances, deposits,
 * escrow holds, listings, active and closed orders, provider bonds, category
 * holds, treasury, paymaster and evidence-exposure state, and the idempotency
 * and replay records (encoded by marketplace-state.ts), so a restart loses
 * nothing that the snapshot covers. A migrated format 1 / 2 / 3 snapshot has
 * `state: null` (receipts only, the earlier behaviour): restoring it keeps
 * the receipts and the order counter, and balances must be re-funded from
 * the external rail as before.
 *
 * Not in the snapshot (by design): runtime capabilities and code (category
 * service hooks, category settlement ports, oracle gates, drip and rollback
 * capabilities). They are re-attached by the process before restore; the
 * snapshot records which categories had hooks attached and restore refuses
 * when they are missing.
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
import { LEGACY_SETTLEMENT_RECEIPT_VERSION, type SettlementBatch, type SettlementReceipt } from "../settlement/types.ts";
import { MARKETPLACE_STATE_VERSION } from "./marketplace-state.ts";
import { publicKeyHexOf, signEd25519, verifyEd25519, type PrivateKeyLike, type PublicKeyLike } from "../core/ed25519.ts";

export const MARKETPLACE_SNAPSHOT_KIND = "uep-marketplace-snapshot" as const;
export const MARKETPLACE_SNAPSHOT_FORMAT_VERSION = 4;
export const OLDEST_MIGRATABLE_MARKETPLACE_SNAPSHOT_FORMAT = 1;
/** First format that must be signed. */
export const FIRST_SIGNED_MARKETPLACE_SNAPSHOT_FORMAT = 3;
const SNAPSHOT_DOMAIN = "UEP-MARKETPLACE-SNAPSHOT-v1";
const SNAPSHOT_SIGNATURE_DOMAIN = "UEP-MARKETPLACE-SNAPSHOT-SIG-v1";

export type MarketplaceSnapshotSignature = { publicKeyHex: string; signature: string };
/** Restore trust: the Marketplace snapshot public keys and how many must have signed (default 1). */
export type MarketplaceSnapshotTrust = {
  snapshotPublicKeys: readonly PublicKeyLike[];
  threshold?: number;
  /** Compatibility shim: restore an unsigned format 1 / 2 snapshot (written before snapshots were signed). */
  acceptUnsignedLegacySnapshot?: boolean;
};

export type MarketplaceSettlementSection = {
  /** Format 2: distinct receipt versions present (v2, and legacy v1 receipts restored from older snapshots). */
  receiptVersions: SettlementReceipt["version"][];
  count: number;
  /** RFC 9162 root over receipt hashes, in execution order (null when empty). */
  batchRoot: string | null;
  totals: SettlementBatch["totals"];
  receipts: SettlementReceipt[];
  /** Format 3: settlement ids of legacy v1 receipts carried over from a migrated format 1 / 2 snapshot (the only accepted v1 receipts). */
  legacyV1SettlementIds: string[];
};

export type MarketplaceSnapshotPayload = {
  kind: typeof MARKETPLACE_SNAPSHOT_KIND;
  formatVersion: number;
  marketplaceId: string;
  treasuryId: string;
  /** Format 2: network of the Marketplace (null for a migrated format 1 snapshot). */
  networkId: string | null;
  height: number;
  /** Format 3: order-id counter of the Marketplace (ids generated after a restore continue from it). */
  orderSequence: number;
  settlement: MarketplaceSettlementSection;
  /** Format 4: full Marketplace state (null for a migrated format 1 / 2 / 3 snapshot: receipts only). */
  state: MarketplaceStateSection | null;
};

/** Format 4: Marketplace state, encoded with marketplace-state.ts (tagged JSON). */
export type MarketplaceStateSection = {
  stateVersion: number;
  /** Configuration the state depends on (checked on restore, not restored). */
  config: Record<string, unknown>;
  marketplace: Record<string, unknown>;
  treasury: Record<string, unknown>;
  reputation: Record<string, unknown>;
  paymaster: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  settlementEngine: Record<string, unknown>;
};

export type MarketplaceSnapshot = MarketplaceSnapshotPayload & { snapshotHash: string; signatures?: MarketplaceSnapshotSignature[] };

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
  {
    from: 2,
    to: 3,
    title: "order-id counter and explicit legacy v1 receipt list (signed snapshots)",
    derivation: [
      "orderSequence = settlement.count: generated ids are hashes of the counter, so the counter cannot be read back from an id; the number of persisted receipts is a lower bound, and reserve() skips every generated id that already has a receipt",
      "settlement.legacyV1SettlementIds = settlement ids of the v1 receipts present (they come from a format 1 / 2 snapshot)",
      "receipts are unchanged; the unsigned source snapshot restores only with acceptUnsignedLegacySnapshot",
    ],
    fixtures: ["mkt-v2-receipts-v1-v2.json"],
    migrate(p: Record<string, unknown>): Record<string, unknown> {
      if (p.formatVersion !== 2) throw new Error("MARKETPLACE_MIGRATION_2_3: expected format 2");
      const settlement = { ...(p.settlement as Record<string, unknown>) };
      const receipts = Array.isArray(settlement.receipts) ? (settlement.receipts as SettlementReceipt[]) : [];
      settlement.legacyV1SettlementIds = receipts.filter((r) => r && r.version === LEGACY_SETTLEMENT_RECEIPT_VERSION).map((r) => r.settlementId);
      const count = typeof settlement.count === "number" ? settlement.count : receipts.length;
      return { ...p, orderSequence: count, settlement };
    },
  },
  {
    from: 3,
    to: 4,
    title: "full Marketplace state section",
    derivation: [
      "state = null: format 3 persisted receipts and the order counter only; a migrated snapshot restores exactly what format 3 restored (receipts, legacy list, order counter)",
      "receipts, orderSequence and the signature rule are unchanged (the source snapshot's signatures are checked on the snapshot as written)",
    ],
    fixtures: ["mkt-v3-receipts-signed.json"],
    migrate(p: Record<string, unknown>): Record<string, unknown> {
      if (p.formatVersion !== 3) throw new Error("MARKETPLACE_MIGRATION_3_4: expected format 3");
      return { ...p, state: null };
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

function signatureMessage(snapshotHash: string): string {
  return canonicalJson([SNAPSHOT_SIGNATURE_DOMAIN, snapshotHash]);
}

/** Build a snapshot of the given receipts (execution order), signed by `signingKeys` (format 3). */
export function buildMarketplaceSnapshot(input: { marketplaceId: string; treasuryId: string; networkId: string; height: number; orderSequence: number; receipts: readonly SettlementReceipt[]; legacyV1SettlementIds?: readonly string[]; state?: MarketplaceStateSection | null; signingKeys: readonly PrivateKeyLike[] }): MarketplaceSnapshot {
  if (!Number.isSafeInteger(input.height) || input.height < 0) throw new Error("MARKETPLACE_SNAPSHOT_HEIGHT_INVALID");
  if (!Number.isSafeInteger(input.orderSequence) || input.orderSequence < 0) throw new Error("MARKETPLACE_SNAPSHOT_SEQUENCE_INVALID");
  if (!Array.isArray(input.signingKeys) || input.signingKeys.length === 0) throw new Error("MARKETPLACE_SNAPSHOT_SIGNING_KEY_REQUIRED");
  const receipts = input.receipts.map((r) => ({ ...r }));
  const batch = receipts.length ? settlementBatch(receipts) : undefined;
  const payload: MarketplaceSnapshotPayload = {
    kind: MARKETPLACE_SNAPSHOT_KIND,
    formatVersion: MARKETPLACE_SNAPSHOT_FORMAT_VERSION,
    marketplaceId: input.marketplaceId,
    treasuryId: input.treasuryId,
    networkId: input.networkId,
    height: input.height,
    orderSequence: input.orderSequence,
    settlement: {
      receiptVersions: [...new Set(receipts.map((r) => r.version))].sort(),
      count: receipts.length,
      batchRoot: batch?.root ?? null,
      totals: batch?.totals ?? {},
      receipts,
      legacyV1SettlementIds: [...(input.legacyV1SettlementIds ?? [])],
    },
    state: input.state ?? null,
  };
  const snapshotHash = marketplaceSnapshotHash(payload);
  const signatures = input.signingKeys.map((k) => ({ publicKeyHex: publicKeyHexOf(k as PublicKeyLike), signature: signEd25519(signatureMessage(snapshotHash), k) }));
  return { ...payload, snapshotHash, signatures };
}

/**
 * v0.5.3: check the snapshot signatures against `trust` (on the snapshot as
 * written). Format 3+ needs `threshold` distinct trusted signatures; an
 * unsigned format 1 / 2 snapshot passes only with acceptUnsignedLegacySnapshot.
 */
export function verifyMarketplaceSnapshotSignatures(snapshot: Record<string, unknown>, trust: MarketplaceSnapshotTrust | undefined): void {
  if (!trust || !Array.isArray(trust.snapshotPublicKeys)) throw new Error("MARKETPLACE_SNAPSHOT_TRUST_REQUIRED: pass { snapshotPublicKeys }");
  const format = snapshot.formatVersion as number;
  const sigs = snapshot.signatures;
  if (format < FIRST_SIGNED_MARKETPLACE_SNAPSHOT_FORMAT && (sigs === undefined || (Array.isArray(sigs) && sigs.length === 0))) {
    if (trust.acceptUnsignedLegacySnapshot === true) return;
    throw new Error("MARKETPLACE_SNAPSHOT_UNSIGNED: an unsigned format 1 / 2 snapshot restores only with acceptUnsignedLegacySnapshot");
  }
  const trusted = new Set<string>();
  for (const k of trust.snapshotPublicKeys) {
    try { trusted.add(publicKeyHexOf(k)); } catch { throw new Error("MARKETPLACE_SNAPSHOT_TRUST_INVALID"); }
  }
  const threshold = trust.threshold ?? 1;
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > trusted.size) throw new Error("MARKETPLACE_SNAPSHOT_TRUST_INVALID: threshold");
  if (!Array.isArray(sigs)) throw new Error("MARKETPLACE_SNAPSHOT_UNSIGNED");
  const hash = snapshot.snapshotHash as string;
  const ok = new Set<string>();
  for (const s of sigs as MarketplaceSnapshotSignature[]) {
    let hex: string;
    try { hex = publicKeyHexOf(s.publicKeyHex); } catch { continue; }
    if (trusted.has(hex) && verifyEd25519(signatureMessage(hash), s.signature, hex)) ok.add(hex);
  }
  if (ok.size < threshold) throw new Error(`MARKETPLACE_SNAPSHOT_SIGNATURE_INVALID: ${ok.size} of ${threshold} trusted signatures`);
}

/** Apply the registered steps from the snapshot's format up to the current one. */
export function migrateMarketplaceSnapshot(snapshot: Record<string, unknown>): MarketplaceSnapshot {
  if (!snapshot || typeof snapshot !== "object" || snapshot.kind !== MARKETPLACE_SNAPSHOT_KIND) throw new Error("MARKETPLACE_SNAPSHOT_INVALID: kind");
  const from = snapshot.formatVersion;
  if (!Number.isSafeInteger(from)) throw new Error("MARKETPLACE_SNAPSHOT_INVALID: formatVersion");
  if ((from as number) > MARKETPLACE_SNAPSHOT_FORMAT_VERSION) throw new Error(`MARKETPLACE_SNAPSHOT_FORMAT_UNSUPPORTED: format ${from} is newer than ${MARKETPLACE_SNAPSHOT_FORMAT_VERSION}`);
  if ((from as number) < OLDEST_MIGRATABLE_MARKETPLACE_SNAPSHOT_FORMAT) throw new Error(`MARKETPLACE_SNAPSHOT_FORMAT_UNSUPPORTED: format ${from}`);
  // The hash is checked on the snapshot as written, before any step.
  const { snapshotHash, signatures: _sigs, ...payload } = snapshot as unknown as MarketplaceSnapshot;
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
  if (!Number.isSafeInteger(snapshot.orderSequence) || snapshot.orderSequence < 0) throw new Error("MARKETPLACE_SNAPSHOT_INVALID: orderSequence");
  if (!Array.isArray(s.legacyV1SettlementIds)) throw new Error("MARKETPLACE_SNAPSHOT_INVALID: legacyV1SettlementIds");
  const st = snapshot.state;
  if (st !== null) {
    if (!st || typeof st !== "object" || st.stateVersion !== MARKETPLACE_STATE_VERSION) throw new Error("MARKETPLACE_SNAPSHOT_INVALID: state");
    for (const k of ["config", "marketplace", "treasury", "reputation", "evidence", "settlementEngine"] as const) if (!st[k] || typeof st[k] !== "object") throw new Error(`MARKETPLACE_SNAPSHOT_INVALID: state.${k}`);
    if (st.paymaster !== null && (!st.paymaster || typeof st.paymaster !== "object")) throw new Error("MARKETPLACE_SNAPSHOT_INVALID: state.paymaster");
  }
  const legacy = new Set(s.legacyV1SettlementIds);
  for (const r of s.receipts) {
    if (!isKnownReceiptVersion(r.version) || !s.receiptVersions.includes(r.version) || !verifySettlementReceipt(r)) throw new Error("SETTLEMENT_RECEIPT_INVALID");
    // v0.5.3: a v1 receipt (no network in its hash) is accepted only as a listed legacy receipt of a migrated old snapshot.
    if (r.version === LEGACY_SETTLEMENT_RECEIPT_VERSION && !legacy.has(r.settlementId)) throw new Error("SETTLEMENT_RECEIPT_LEGACY_NOT_ALLOWED: v1 receipts are accepted only from migrated format 1 / 2 snapshots");
    if (r.treasuryId !== expect.treasuryId) throw new Error("SETTLEMENT_RECEIPT_TREASURY_MISMATCH");
    if (r.networkId !== undefined && expect.networkId !== undefined && r.networkId !== expect.networkId) throw new Error("SETTLEMENT_RECEIPT_NETWORK_MISMATCH");
  }
  const v1Ids = new Set(s.receipts.filter((r) => r.version === LEGACY_SETTLEMENT_RECEIPT_VERSION).map((r) => r.settlementId));
  if (legacy.size !== s.legacyV1SettlementIds.length || [...legacy].some((id) => !v1Ids.has(id))) throw new Error("MARKETPLACE_SNAPSHOT_INVALID: legacyV1SettlementIds lists a receipt that is not a v1 receipt");
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
export function marketplaceSnapshotShape(snapshot: MarketplaceSnapshot): { formatVersion: number; payloadKeys: string[]; settlementKeys: string[]; receiptKeys: string[]; stateKeys: string[] } {
  const { snapshotHash: _h, signatures: _s, ...payload } = snapshot;
  return {
    formatVersion: snapshot.formatVersion,
    payloadKeys: Object.keys(payload).sort(),
    settlementKeys: Object.keys(snapshot.settlement).sort(),
    receiptKeys: Object.keys(snapshot.settlement.receipts[0] ?? {}).sort(),
    stateKeys: Object.keys(snapshot.state ?? {}).sort(),
  };
}
