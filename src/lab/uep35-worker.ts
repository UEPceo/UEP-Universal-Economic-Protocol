/**
 * UEP-35.5 / 35.6.1 — Worker Layer (DATA PLANE). Does NOT decide finality.
 */

import type { BatchTx } from "./uep35-batch-lab.ts";
import { ScaleMempool, type MempoolConfig } from "./uep35-scale-mempool.ts";
import {
  BatchDag,
  type DagBatchHeader,
  headerCanonicalBody,
  computeBatchId,
} from "./uep35-dag.ts";
import type { NodeIdentity, NodeRegistry } from "./node-identity.ts";
import { signBytes } from "./node-identity.ts";
import { batchDigest, txByteSize } from "./uep35-scale-mempool.ts";

export type WorkerConfig = {
  workerId: string;
  epoch: number;
  mempool?: Partial<MempoolConfig>;
  /** Optional crypto identity for header signatures */
  identity?: NodeIdentity;
};

export class UepWorker {
  readonly workerId: string;
  readonly epoch: number;
  readonly mempool: ScaleMempool;
  readonly dag = new BatchDag();
  private height = 0;
  private lastBatchId: string | null = null;
  private recoveryServed = new Set<string>();
  private identity?: NodeIdentity;

  constructor(cfg: WorkerConfig) {
    this.workerId = cfg.workerId;
    this.epoch = cfg.epoch;
    this.mempool = new ScaleMempool(cfg.mempool);
    this.identity = cfg.identity;
  }

  admit(tx: BatchTx) {
    return this.mempool.admit(tx);
  }

  produceBatch(): { header: DagBatchHeader; txs: BatchTx[] } | null {
    const txs = this.mempool.takeBatch();
    if (txs.length === 0) return null;
    this.height += 1;
    const parents = this.lastBatchId ? [this.lastBatchId] : [];
    const byteSize = txs.reduce((s, t) => s + txByteSize(t), 0);
    const txDigest = batchDigest(txs);
    const batchId = computeBatchId({
      workerId: this.workerId,
      epoch: this.epoch,
      height: this.height,
      parents,
      txDigest,
      txCount: txs.length,
      byteSize,
    });
    let header = this.dag.buildHeader({
      batchId,
      epoch: this.epoch,
      height: this.height,
      parents,
      txs,
      producerId: this.workerId,
      ts: this.height, // deterministic in lab (not Date.now)
    });
    if (this.identity) {
      const body = headerCanonicalBody(header);
      header = {
        ...header,
        producerPublicKeyHex: this.identity.publicKeyHex,
        producerSignature: signBytes(this.identity, body),
      };
    }
    this.dag.acceptHeader(header);
    this.dag.acceptBody(batchId, txs);
    this.lastBatchId = batchId;
    return { header, txs };
  }

  announceHeader(
    h: DagBatchHeader,
    requireSig = false,
    registry?: NodeRegistry,
  ) {
    return this.dag.acceptHeader(h, {
      requireProducerSig: requireSig || !!registry,
      registry,
    });
  }

  respondBatch(
    batchId: string,
    requestId: string,
  ):
    | { ok: true; header: DagBatchHeader; txs: BatchTx[] }
    | { ok: false; reason: string } {
    if (this.recoveryServed.has(requestId)) {
      return { ok: false, reason: "DUPLICATE_REQUEST" };
    }
    const header = this.dag.getHeader(batchId);
    const txs = this.dag.getBody(batchId);
    if (!header || !txs) return { ok: false, reason: "BATCH_NOT_FOUND" };
    this.recoveryServed.add(requestId);
    return { ok: true, header, txs };
  }

  ingestRecovery(
    header: DagBatchHeader,
    txs: BatchTx[],
  ): { ok: true } | { ok: false; reason: string } {
    const hr = this.dag.acceptHeader(header);
    if (!hr.ok) return hr;
    return this.dag.acceptBody(header.batchId, txs);
  }
}
