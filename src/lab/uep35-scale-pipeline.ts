/**
 * UEP-35.4 — Scale pipeline: mempool → waves → structural execute → metrics
 *
 * LAB path toward high throughput without per-TX Groth16 in the hot path.
 * ZK remains available per-TX outside this structural scale lab.
 */

import {
  ExecutionEngine,
  type CommitResult,
} from "./execution-engine.ts";
import {
  seedLabEngine,
  partitionBySender,
  type BatchTx,
  type BatchResult,
} from "./uep35-batch-lab.ts";
import {
  ScaleMempool,
  batchDigest,
  type BatchHeader,
  type MempoolConfig,
} from "./uep35-scale-mempool.ts";
import { creatorFee } from "../core/fee.ts";

export type ScalePipelineConfig = {
  accounts: number;
  initialBalance: bigint;
  proveConcurrency: number;
  mempool?: Partial<MempoolConfig>;
};

export type ScaleRunReport = {
  headers: BatchHeader[];
  batches: BatchResult[];
  totalTx: number;
  committed: number;
  rejected: number;
  wallMs: number;
  txPerSec: number;
  waveCount: number;
  conservationOk: boolean;
  totalValue: bigint;
  treasuryFees: bigint;
};

function accountLabel(i: number): string {
  return `a${i}`;
}

export class ScalePipeline {
  readonly engine: ExecutionEngine;
  readonly mempool: ScaleMempool;
  readonly accountCount: number;
  private totalValue: bigint;
  private seed: number;

  constructor(cfg: ScalePipelineConfig & { seed?: number }) {
    this.seed = cfg.seed ?? 1;
    this.accountCount = cfg.accounts;
    this.totalValue = cfg.initialBalance * BigInt(cfg.accounts);
    const labels = [];
    for (let i = 0; i < cfg.accounts; i++) {
      labels.push({
        label: accountLabel(i),
        balance: cfg.initialBalance,
        id: BigInt(10_000 + i),
      });
    }
    this.engine = seedLabEngine(labels, {
      proveConcurrency: cfg.proveConcurrency,
      oneInFlightPerSender: false,
      requireProof: false,
      depth: 4,
      profile: "local",
    });
    this.mempool = new ScaleMempool(cfg.mempool);
  }

  /** Generate load: random-ish independent spends across accounts. */
  injectLoad(count: number, amount: bigint = 1n): number {
    const txs: BatchTx[] = [];
    for (let i = 0; i < count; i++) {
      const from = i % this.accountCount;
      let to = (i * 7 + 3) % this.accountCount;
      if (to === from) to = (to + 1) % this.accountCount;
      txs.push({
        id: `load-${this.seed}-${i}`,
        from: accountLabel(from),
        to: accountLabel(to),
        amount,
      });
    }
    return this.mempool.admitMany(txs).admitted;
  }

  sumBalances(): bigint {
    let s = 0n;
    for (let i = 0; i < this.accountCount; i++) {
      s += this.engine.getAccount(accountLabel(i)).balance;
    }
    return s + this.engine.treasuryBalance;
  }

  /**
   * Drain mempool in batches and execute structurally.
   */
  async drain(maxBatches = 100): Promise<ScaleRunReport> {
    const t0 = performance.now();
    const headers: BatchHeader[] = [];
    const batches: BatchResult[] = [];
    let totalTx = 0;
    let committed = 0;
    let rejected = 0;
    let waveCount = 0;

    for (let b = 0; b < maxBatches; b++) {
      const txs = this.mempool.takeBatch();
      if (txs.length === 0) break;
      const waves = partitionBySender(txs);
      waveCount += waves.length;
      const digest = batchDigest(txs);
      const batchId = `B-${b}-${digest.slice(0, 12)}`;
      headers.push({
        batchId,
        digest,
        txCount: txs.length,
        waveHint: waves.length,
        ts: Date.now(),
      });

      const t1 = performance.now();
      let accepted = 0;
      let rej = 0;
      for (const tx of txs) {
        const r = this.engine.enqueue({
          id: tx.id,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
        });
        if (r.ok) accepted++;
        else rej++;
      }
      const { commits, waves: w } = await this.engine.runScheduled();
      waveCount += 0; // already counted from partition
      const okCommits = commits.filter((c) => c.ok);
      committed += okCommits.length;
      rejected += rej + commits.filter((c) => !c.ok).length;
      totalTx += txs.length;
      let totalTransferred = 0n;
      for (const c of okCommits) {
        const tx = txs.find((t) => t.id === c.intentId);
        if (tx) totalTransferred += tx.amount;
      }
      batches.push({
        batchId,
        accepted,
        rejected: rej,
        commits,
        wallMs: performance.now() - t1,
        totalTransferred,
      });
    }

    const wallMs = performance.now() - t0;
    const conservationOk = this.sumBalances() === this.totalValue;
    return {
      headers,
      batches,
      totalTx,
      committed,
      rejected,
      wallMs,
      txPerSec: wallMs > 0 ? (committed * 1000) / wallMs : 0,
      waveCount,
      conservationOk,
      totalValue: this.totalValue,
      treasuryFees: this.engine.treasuryBalance,
    };
  }
}

/**
 * In-process fan-out of batch headers (propagation lab, not production gossip).
 */
export class BatchHeaderBus {
  private subscribers = new Map<string, (h: BatchHeader) => void>();
  readonly seen = new Set<string>();
  stats = { published: 0, delivered: 0, duplicates: 0 };

  subscribe(nodeId: string, fn: (h: BatchHeader) => void): void {
    this.subscribers.set(nodeId, fn);
  }

  publish(h: BatchHeader): void {
    if (this.seen.has(h.digest)) {
      this.stats.duplicates++;
      return;
    }
    this.seen.add(h.digest);
    this.stats.published++;
    for (const fn of this.subscribers.values()) {
      fn(h);
      this.stats.delivered++;
    }
  }
}
