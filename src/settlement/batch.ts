/**
 * Settlement receipt batches: an RFC 9162 Merkle root over receipt hashes and
 * per-asset totals, plus inclusion proofs for one receipt. Pure functions: no
 * clock, no timing (the incoming batch measured wall-clock throughput, which
 * a transition must not do and which is not a claim this repository makes).
 */
import { merkleLeafHash, merklePath, merkleRoot, verifyMerklePath } from "../core/rfc9162-merkle.ts";
import { verifySettlementReceipt } from "./engine.ts";
import type { SettlementBatch, SettlementReceipt } from "./types.ts";

function leafOf(receipt: SettlementReceipt): Buffer {
  if (!/^[0-9a-f]{64}$/.test(receipt.receiptHash)) throw new Error("RECEIPT_HASH_INVALID");
  return merkleLeafHash(Buffer.from(receipt.receiptHash, "hex"));
}

/** Commit to a non-empty list of receipts. Every receipt hash is re-checked first. */
export function settlementBatch(receipts: readonly SettlementReceipt[]): SettlementBatch {
  if (!Array.isArray(receipts) || receipts.length === 0) throw new Error("BATCH_EMPTY");
  const seen = new Set<string>();
  const totals: SettlementBatch["totals"] = {};
  for (const r of receipts) {
    if (!verifySettlementReceipt(r)) throw new Error("RECEIPT_HASH_INVALID");
    if (seen.has(r.settlementId)) throw new Error("BATCH_DUPLICATE_SETTLEMENT");
    seen.add(r.settlementId);
    const t = (totals[r.asset] ??= { gross: 0n, fees: 0n, providerNet: 0n, refunds: 0n, gas: 0n });
    t.gross += r.grossAmount;
    t.fees += r.marketplaceFee;
    t.providerNet += r.providerNet;
    t.refunds += r.buyerRefund;
    t.gas += r.gasCaptured;
  }
  return { root: merkleRoot(receipts.map(leafOf)).toString("hex"), count: receipts.length, totals };
}

/** Inclusion path (hex siblings) of receipt `index` in the batch. */
export function receiptInclusionProof(receipts: readonly SettlementReceipt[], index: number): string[] {
  return merklePath(receipts.map(leafOf), index).map((b) => b.toString("hex"));
}

/** Verify that `receipt` is leaf `index` of a batch of `size` receipts with `root`. */
export function verifyReceiptInclusion(receipt: SettlementReceipt, index: number, size: number, path: readonly string[], root: string): boolean {
  if (!verifySettlementReceipt(receipt)) return false;
  if (!Array.isArray(path) || path.some((p) => typeof p !== "string" || !/^[0-9a-f]{64}$/.test(p)) || !/^[0-9a-f]{64}$/.test(root)) return false;
  return verifyMerklePath(leafOf(receipt), index, size, path.map((p) => Buffer.from(p, "hex")), Buffer.from(root, "hex"));
}
