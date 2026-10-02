/**
 * UEP-35.4 / 35.5 — Scale mempool + batch builder (LAB)
 *
 * Mempool deduplication ≠ protocol replay protection.
 * Removing a TX from the mempool `seen` set does NOT clear ledger
 * nullifier / transitionId / sequence protection.
 */

import { createHash } from "node:crypto";
import type { BatchTx } from "./uep35-batch-lab.ts";
import { partitionBySender } from "./uep35-batch-lab.ts";

export type MempoolConfig = {
  maxBatchSize: number;
  maxBatchBytes: number;
  maxPending: number;
};

export const DEFAULT_MEMPOOL: MempoolConfig = {
  maxBatchSize: 256,
  maxBatchBytes: 256_000,
  maxPending: 50_000,
};

export type MempoolAdmit =
  | { ok: true }
  | {
      ok: false;
      reason: "DUPLICATE" | "FULL" | "BAD_AMOUNT" | "TX_TOO_LARGE";
    };

/** Approximate serialized size of a BatchTx for maxBatchBytes. */
export function txByteSize(tx: BatchTx): number {
  // id + from + to + amount decimal + separators
  return (
    Buffer.byteLength(tx.id, "utf8") +
    Buffer.byteLength(tx.from, "utf8") +
    Buffer.byteLength(tx.to, "utf8") +
    tx.amount.toString().length +
    8
  );
}

export class ScaleMempool {
  readonly cfg: MempoolConfig;
  private pending: BatchTx[] = [];
  /** Short-lived intake dedup only — NOT protocol replay protection. */
  private seen = new Set<string>();
  stats = {
    admitted: 0,
    rejected: 0,
    batchesFormed: 0,
    dropped: 0,
    oversizedSkipped: 0,
  };

  constructor(cfg: Partial<MempoolConfig> = {}) {
    this.cfg = { ...DEFAULT_MEMPOOL, ...cfg };
  }

  size(): number {
    return this.pending.length;
  }

  admit(tx: BatchTx): MempoolAdmit {
    // ECON-04: hold_release may use amount 0
    const isProtocol =
      tx.kind === "hold_open" ||
      tx.kind === "hold_release" ||
      tx.kind === "hold_consume";
    if (tx.amount <= 0n && !isProtocol) {
      this.stats.rejected++;
      return { ok: false, reason: "BAD_AMOUNT" };
    }
    if (tx.kind === "hold_release" && tx.amount < 0n) {
      this.stats.rejected++;
      return { ok: false, reason: "BAD_AMOUNT" };
    }
    if (txByteSize(tx) > this.cfg.maxBatchBytes) {
      // Never admit: would block takeBatch forever if left in queue
      this.stats.rejected++;
      return { ok: false, reason: "TX_TOO_LARGE" };
    }
    if (this.seen.has(tx.id)) {
      this.stats.rejected++;
      return { ok: false, reason: "DUPLICATE" };
    }
    if (this.pending.length >= this.cfg.maxPending) {
      const old = this.pending.shift();
      if (old) {
        this.seen.delete(old.id);
        this.stats.dropped++;
      }
    }
    this.pending.push(tx);
    this.seen.add(tx.id);
    this.stats.admitted++;
    return { ok: true };
  }

  admitMany(txs: BatchTx[]): { admitted: number; rejected: number } {
    let admitted = 0;
    let rejected = 0;
    for (const tx of txs) {
      if (this.admit(tx).ok) admitted++;
      else rejected++;
    }
    return { admitted, rejected };
  }

  /**
   * Form next batch respecting BOTH maxBatchSize and maxBatchBytes.
   * Skips (drops from front) any residual oversized edge cases without blocking.
   */
  takeBatch(maxSize?: number): BatchTx[] {
    const sizeLimit = maxSize ?? this.cfg.maxBatchSize;
    const byteLimit = this.cfg.maxBatchBytes;
    const batch: BatchTx[] = [];
    let bytes = 0;

    while (this.pending.length > 0 && batch.length < sizeLimit) {
      const next = this.pending[0]!;
      const sz = txByteSize(next);
      if (sz > byteLimit) {
        // Should not happen after admit filter; drop to avoid permanent block
        this.pending.shift();
        this.seen.delete(next.id);
        this.stats.oversizedSkipped++;
        continue;
      }
      if (batch.length > 0 && bytes + sz > byteLimit) break;
      this.pending.shift();
      this.seen.delete(next.id);
      batch.push(next);
      bytes += sz;
    }
    if (batch.length > 0) this.stats.batchesFormed++;
    return batch;
  }

  /** Test helper: whether intake still remembers id (NOT ledger protection). */
  hasIntakeSeen(id: string): boolean {
    return this.seen.has(id);
  }

  peekScheduleHint(): { waveCount: number; maxWave: number } {
    const waves = partitionBySender(this.pending);
    return {
      waveCount: waves.length,
      maxWave: waves.reduce((m, w) => Math.max(m, w.length), 0),
    };
  }
}

export function batchDigest(txs: BatchTx[]): string {
  const h = createHash("sha256");
  h.update("UEP-35.4-BATCH|");
  for (const tx of txs) {
    h.update(`${tx.id}|${tx.from}|${tx.to}|${tx.amount.toString()};`);
  }
  return h.digest("hex");
}

export type BatchHeader = {
  batchId: string;
  digest: string;
  txCount: number;
  waveHint: number;
  ts: number;
};
