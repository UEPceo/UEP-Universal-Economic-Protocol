/**
 * v0.5.3 settlement bridge: anchors of Marketplace settlement batches in the
 * consensus (ledger) state.
 *
 * The Marketplace is a business-accounting layer: its balances are not ledger
 * notes. What this bridge makes verifiable is that every settled order (and
 * category hold) produced exactly one receipt, that each receipt conserves its
 * escrow, and that the batch of receipts was committed into the ledger state in
 * order, once. The ledger checks the receipts itself (hashes, conservation,
 * duplicates, RFC 9162 root, per-asset totals) before it appends an anchor,
 * chains anchors by hash, commits them in the signed snapshot and re-checks
 * the chain on restore. A client holding a receipt can verify inclusion with
 * `verifyReceiptInclusion` against the anchored root.
 *
 * Not claimed: the anchor does not move ledger value (Marketplace balances
 * stay outside the ledger's note model) and the ledger does not re-execute
 * the Marketplace rules (who may settle, dispute outcomes). See
 * docs/SETTLEMENT-BRIDGE.md.
 *
 * Pure: no clock, no keys. The height is the ledger height passed in.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../core/canonical-json.ts";
import { settlementBatch } from "./batch.ts";
import { verifySettlementReceipt } from "./engine.ts";
import type { SettlementReceipt } from "./types.ts";

export const SETTLEMENT_ANCHOR_DOMAIN = "UEP-SETTLEMENT-ANCHOR-v1";
export const GENESIS_ANCHOR_HASH = "0".repeat(64);
/** Upper bound of receipts per anchor (keeps one transition bounded). */
export const MAX_RECEIPTS_PER_ANCHOR = 4096;

export type SettlementAnchorTotals = Record<string, { gross: string; fees: string; providerNet: string; refunds: string; gas: string }>;

export type SettlementAnchor = {
  index: number;
  marketplaceId: string;
  treasuryId: string;
  /** Ledger height at which the anchor was appended. */
  height: number;
  count: number;
  batchRoot: string;
  totals: SettlementAnchorTotals;
  /** Settlement ids in batch order (lets the ledger refuse a second anchor of the same settlement after restore). */
  settlementIds: string[];
  prevAnchorHash: string;
  anchorHash: string;
};

export function settlementAnchorHash(a: Omit<SettlementAnchor, "anchorHash">): string {
  return createHash("sha256").update(canonicalJson([SETTLEMENT_ANCHOR_DOMAIN, a])).digest("hex");
}

/** Per-receipt checks done by the ledger before anchoring. Returns a problem or undefined. */
export function receiptProblem(r: SettlementReceipt, treasuryId: string): string | undefined {
  if (!r || typeof r !== "object") return "receipt is not an object";
  if (!verifySettlementReceipt(r)) return `receipt ${String(r.settlementId)}: hash does not match its fields`;
  if (r.treasuryId !== treasuryId) return `receipt ${r.settlementId}: treasury mismatch`;
  for (const k of ["grossAmount", "providerAmount", "marketplaceFee", "providerNet", "gasCaptured", "buyerRefund"] as const) {
    if (typeof r[k] !== "bigint" || r[k] < 0n || r[k] >= 2n ** 64n) return `receipt ${r.settlementId}: ${k} out of range`;
  }
  if (r.providerAmount > r.grossAmount) return `receipt ${r.settlementId}: providerAmount exceeds gross`;
  if (r.providerNet + r.marketplaceFee !== r.providerAmount) return `receipt ${r.settlementId}: provider share not conserved`;
  if (r.buyerRefund < r.grossAmount - r.providerAmount) return `receipt ${r.settlementId}: refund below the unpaid gross`;
  return undefined;
}

/** Build the next anchor (throws SETTLEMENT_ANCHOR_INVALID: ...). `anchored` = settlement ids already anchored for this marketplace. */
export function buildSettlementAnchor(input: {
  index: number;
  prevAnchorHash: string;
  height: number;
  marketplaceId: string;
  treasuryId: string;
  receipts: readonly SettlementReceipt[];
  anchored: ReadonlySet<string>;
}): SettlementAnchor {
  const fail = (d: string): never => { throw new Error(`SETTLEMENT_ANCHOR_INVALID: ${d}`); };
  if (typeof input.marketplaceId !== "string" || !input.marketplaceId || typeof input.treasuryId !== "string" || !input.treasuryId) fail("marketplaceId and treasuryId are required");
  if (!Array.isArray(input.receipts) || input.receipts.length === 0) fail("no receipts");
  if (input.receipts.length > MAX_RECEIPTS_PER_ANCHOR) fail(`at most ${MAX_RECEIPTS_PER_ANCHOR} receipts per anchor`);
  for (const r of input.receipts) {
    const p = receiptProblem(r, input.treasuryId);
    if (p) fail(p);
    if (input.anchored.has(r.settlementId)) fail(`settlement ${r.settlementId} is already anchored`);
  }
  let batch;
  try { batch = settlementBatch(input.receipts); } catch (e) { fail((e as Error).message); }
  const totals: SettlementAnchorTotals = {};
  for (const [asset, t] of Object.entries(batch!.totals)) totals[asset] = { gross: t.gross.toString(), fees: t.fees.toString(), providerNet: t.providerNet.toString(), refunds: t.refunds.toString(), gas: t.gas.toString() };
  const body: Omit<SettlementAnchor, "anchorHash"> = {
    index: input.index,
    marketplaceId: input.marketplaceId,
    treasuryId: input.treasuryId,
    height: input.height,
    count: batch!.count,
    batchRoot: batch!.root,
    totals,
    settlementIds: input.receipts.map((r) => r.settlementId),
    prevAnchorHash: input.prevAnchorHash,
  };
  return { ...body, anchorHash: settlementAnchorHash(body) };
}

/** Re-check a chain of anchors (restore). Returns a problem or undefined. */
export function anchorChainProblem(anchors: unknown): string | undefined {
  if (!Array.isArray(anchors)) return "settlementAnchors must be an array";
  let prev = GENESIS_ANCHOR_HASH;
  const ids = new Map<string, Set<string>>();
  let lastHeight = 0;
  for (const [i, a] of (anchors as SettlementAnchor[]).entries()) {
    if (!a || a.index !== i || a.prevAnchorHash !== prev) return `anchor ${i}: index or chain link`;
    if (!Number.isSafeInteger(a.height) || a.height < lastHeight) return `anchor ${i}: height`;
    if (!Array.isArray(a.settlementIds) || a.settlementIds.length !== a.count || a.count < 1) return `anchor ${i}: settlement ids`;
    const { anchorHash, ...body } = a;
    if (settlementAnchorHash(body) !== anchorHash) return `anchor ${i}: hash`;
    const seen = ids.get(a.marketplaceId) ?? new Set<string>();
    for (const id of a.settlementIds) {
      if (seen.has(id)) return `anchor ${i}: settlement ${id} anchored twice`;
      seen.add(id);
    }
    ids.set(a.marketplaceId, seen);
    prev = anchorHash;
    lastHeight = a.height;
  }
  return undefined;
}
