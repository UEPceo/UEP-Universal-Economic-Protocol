/**
 * UEP-35.5 / 35.6.1 — Batch DAG (headers + availability). NOT consensus.
 */

import { createHash } from "node:crypto";
import type { BatchTx } from "./uep35-batch-lab.ts";
import { batchDigest, txByteSize } from "./uep35-scale-mempool.ts";
import { verifyBytes } from "./node-identity.ts";
import type { NodeRegistry } from "./node-identity.ts";
import { computeBatchId } from "./uep35-batch-id.ts";
export { computeBatchId } from "./uep35-batch-id.ts";

export type DagBatchHeader = {
  batchId: string;
  epoch: number;
  height: number;
  parents: string[];
  txCount: number;
  byteSize: number;
  txDigest: string;
  producerId: string;
  /** Ed25519 signature over headerBody (producer) */
  producerSignature?: string;
  producerPublicKeyHex?: string;
  postStateRoot?: string;
  ts: number;
};

export function headerCanonicalBody(h: Omit<DagBatchHeader, "producerSignature" | "producerPublicKeyHex">): string {
  return [
    "UEP-35.6.1-HDR",
    h.batchId,
    String(h.epoch),
    String(h.height),
    h.parents.join(","),
    String(h.txCount),
    String(h.byteSize),
    h.txDigest,
    h.producerId,
    h.postStateRoot ?? "",
    String(h.ts),
  ].join("|");
}


export class BatchDag {
  private headers = new Map<string, DagBatchHeader>();
  private bodies = new Map<string, BatchTx[]>();
  private maxHeaders: number;
  stats = {
    accepted: 0,
    rejected: 0,
    missingParents: 0,
    cycles: 0,
    recovered: 0,
    ready: 0,
  };

  constructor(opts?: { maxHeaders?: number }) {
    this.maxHeaders = opts?.maxHeaders ?? 10_000;
  }

  hasHeader(batchId: string): boolean {
    return this.headers.has(batchId);
  }

  hasBody(batchId: string): boolean {
    return this.bodies.has(batchId);
  }

  getHeader(batchId: string): DagBatchHeader | undefined {
    return this.headers.get(batchId);
  }

  getBody(batchId: string): BatchTx[] | undefined {
    return this.bodies.get(batchId);
  }

  missingParents(h: DagBatchHeader): string[] {
    return h.parents.filter((p) => !this.headers.has(p));
  }

  /**
   * HEADER_KNOWN vs DAG_READY:
   * ready = header present, all parents ready (recursively), body present, optional producer sig valid if required.
   */
  isReady(batchId: string, requireProducerSig = false): boolean {
    const h = this.headers.get(batchId);
    if (!h) return false;
    if (!this.bodies.has(batchId)) return false;
    if (requireProducerSig) {
      if (!h.producerSignature || !h.producerPublicKeyHex) return false;
      if (!this.verifyProducer(h)) return false;
    }
    for (const p of h.parents) {
      if (!this.isReady(p, requireProducerSig)) return false;
    }
    return true;
  }

  isHeaderKnown(batchId: string): boolean {
    return this.headers.has(batchId);
  }

  verifyProducer(h: DagBatchHeader): boolean {
    if (!h.producerSignature || !h.producerPublicKeyHex) return false;
    const body = headerCanonicalBody(h);
    return verifyBytes(h.producerPublicKeyHex, body, h.producerSignature);
  }

  wouldCycle(h: DagBatchHeader): boolean {
    const visiting = new Set<string>();
    const walk = (id: string): boolean => {
      if (id === h.batchId) return true;
      if (visiting.has(id)) return false;
      visiting.add(id);
      const node = this.headers.get(id);
      if (!node) return false;
      for (const p of node.parents) {
        if (walk(p)) return true;
      }
      return false;
    };
    for (const p of h.parents) {
      if (p === h.batchId) return true;
      if (walk(p)) return true;
    }
    return false;
  }

  private sameIdentity(a: DagBatchHeader, b: DagBatchHeader): boolean {
    return (
      a.txDigest === b.txDigest &&
      a.height === b.height &&
      a.epoch === b.epoch &&
      a.producerId === b.producerId &&
      a.txCount === b.txCount &&
      a.byteSize === b.byteSize &&
      JSON.stringify(a.parents) === JSON.stringify(b.parents)
    );
  }

  acceptHeader(
    h: DagBatchHeader,
    opts?: { requireProducerSig?: boolean; registry?: NodeRegistry },
  ): { ok: true; knownOnly?: boolean } | { ok: false; reason: string } {
    if ((h.parents ?? []).some((p) => p === h.batchId)) {
      this.stats.cycles++;
      this.stats.rejected++;
      return { ok: false, reason: "SELF_PARENT" };
    }
    if (opts?.requireProducerSig || opts?.registry) {
      if (opts.registry) {
        const ent = opts.registry.get(h.producerId);
        if (!ent || ent.status !== "active") {
          this.stats.rejected++;
          return { ok: false, reason: "UNKNOWN_OR_INACTIVE_PRODUCER" };
        }
        if (!h.producerPublicKeyHex || h.producerPublicKeyHex !== ent.publicKeyHex) {
          this.stats.rejected++;
          return { ok: false, reason: "PRODUCER_KEY_MISMATCH" };
        }
      }
      if (!this.verifyProducer(h)) {
        this.stats.rejected++;
        return { ok: false, reason: "PRODUCER_SIG_INVALID" };
      }
    } else if (h.producerSignature && h.producerPublicKeyHex) {
      if (!this.verifyProducer(h)) {
        this.stats.rejected++;
        return { ok: false, reason: "PRODUCER_SIG_INVALID" };
      }
    }
    if (this.headers.has(h.batchId)) {
      const prev = this.headers.get(h.batchId)!;
      if (!this.sameIdentity(prev, h)) {
        this.stats.rejected++;
        return { ok: false, reason: "CONFLICTING_HEADER" };
      }
      return { ok: true };
    }
    if (this.wouldCycle(h)) {
      this.stats.cycles++;
      this.stats.rejected++;
      return { ok: false, reason: "DAG_CYCLE" };
    }
    const miss = this.missingParents(h);
    if (miss.length) this.stats.missingParents++;
    if (this.headers.size >= this.maxHeaders) {
      this.stats.rejected++;
      return { ok: false, reason: "MEMORY_LIMIT" };
    }
    this.headers.set(h.batchId, h);
    this.stats.accepted++;
    return { ok: true, knownOnly: miss.length > 0 };
  }

  acceptBody(
    batchId: string,
    txs: BatchTx[],
  ): { ok: true } | { ok: false; reason: string } {
    const h = this.headers.get(batchId);
    if (!h) return { ok: false, reason: "UNKNOWN_HEADER" };
    const dig = batchDigest(txs);
    if (dig !== h.txDigest) {
      this.stats.rejected++;
      return { ok: false, reason: "DIGEST_MISMATCH" };
    }
    if (txs.length !== h.txCount) {
      return { ok: false, reason: "TX_COUNT_MISMATCH" };
    }
    this.bodies.set(batchId, txs);
    this.stats.recovered++;
    if (this.isReady(batchId)) this.stats.ready++;
    return { ok: true };
  }

  buildHeader(opts: {
    batchId?: string;
    epoch: number;
    height: number;
    parents: string[];
    txs: BatchTx[];
    producerId: string;
    postStateRoot?: string;
    ts?: number;
  }): DagBatchHeader {
    const byteSize = opts.txs.reduce((s, t) => s + txByteSize(t), 0);
    const txDigest = batchDigest(opts.txs);
    const batchId =
      opts.batchId ??
      computeBatchId({
        workerId: opts.producerId,
        epoch: opts.epoch,
        height: opts.height,
        parents: opts.parents,
        txDigest,
        txCount: opts.txs.length,
        byteSize,
      });
    return {
      batchId,
      epoch: opts.epoch,
      height: opts.height,
      parents: opts.parents,
      txCount: opts.txs.length,
      byteSize,
      txDigest,
      producerId: opts.producerId,
      postStateRoot: opts.postStateRoot,
      ts: opts.ts ?? 0,
    };
  }
}
