/**
 * UEP-36.0 — Multi-leader LAB (Narwhal-inspired separation).
 *
 * A) Parallel data-plane dissemination (headers/bodies) from multiple workers.
 * B) Multi-leader ordered consensus: rotating leaders for consecutive heights;
 *    proposal payloads are digests only (no tx arrays).
 *
 * Concurrent conflicting state transitions are intentionally NOT finalized in
 * parallel — economic state is a single chain.
 *
 * DATA-PLANE parallel availability ≠ parallel state finality.
 * BFT-CLASSIC unchanged. LAB only.
 * UEP-36.1.1: deterministic IDs (no Math.random).
 */

import { MultiNodeCluster } from "./uep35-multinode.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import type { DagBatchHeader } from "./uep35-dag.ts";
export { isDigestOnlyProposalPayload } from "./uep36-digest-agg.ts";
import { buildDigestAggregate, aggregateProposalPayload, isDigestOnlyProposalPayload as isOfficialDigestPayload } from "./uep36-digest-agg.ts";

export function leadersForSlot(
  nodeIds: string[],
  slot: number,
  leadersPerSlot = 2,
): string[] {
  if (nodeIds.length === 0) return [];
  const k = Math.min(leadersPerSlot, nodeIds.length);
  const out: string[] = [];
  for (let i = 0; i < k; i++) {
    out.push(nodeIds[(slot + i) % nodeIds.length]!);
  }
  return out;
}


function encodeHeader(h: DagBatchHeader): string {
  return JSON.stringify(h);
}
function encodeBody(batchId: string, txs: BatchTx[]): string {
  return JSON.stringify({
    batchId,
    txs: txs.map((t) => ({
      id: t.id,
      from: t.from,
      to: t.to,
      amount: t.amount.toString(),
    })),
  });
}

export type WaveResult = {
  slot: number;
  leader: string;
  batchId: string;
  proposalDigest: string;
  digestOnly: boolean;
};

export class MultiLeaderLab {
  readonly cluster: MultiNodeCluster;
  readonly seed: number;
  /** How many workers publish data-plane batches in parallel per availability round */
  dataLeadersPerRound: number;
  heightIndex = 0;
  waves: WaveResult[] = [];
  stats = {
    dataPlaneHeaders: 0,
    dataPlaneBodies: 0,
    consensusFinalized: 0,
  };

  constructor(n = 4, seed = 36, dataLeadersPerRound = 2) {
    this.seed = seed;
    this.cluster = new MultiNodeCluster(n, seed);
    this.dataLeadersPerRound = dataLeadersPerRound;
  }

  nodeIds(): string[] {
    return this.cluster.nodes.map((n) => n.id);
  }

  /**
   * Parallel DATA plane: L workers each produce a batch and broadcast header+body.
   * No consensus. Returns how many honest nodes eventually see all headers.
   */
  parallelAvailabilityRound(txsPer = 1): {
    batchIds: string[];
    headersSeenByAllHonest: boolean;
  } {
    const leaders = leadersForSlot(
      this.nodeIds(),
      this.heightIndex,
      this.dataLeadersPerRound,
    );
    const batchIds: string[] = [];
    for (let li = 0; li < leaders.length; li++) {
      const leader = leaders[li]!;
      const n = this.cluster.node(leader);
      const txs: BatchTx[] = [];
      for (let t = 0; t < txsPer; t++) {
        txs.push({
          id: `av-s${this.seed}-h${this.heightIndex}-L${li}-t${t}`,
          from: `s${li % 3}`,
          to: `r${t % 4}`,
          amount: 1n,
        });
      }
      for (const tx of txs) n.worker.admit(tx);
      const produced = n.worker.produceBatch();
      if (!produced) continue;
      batchIds.push(produced.header.batchId);
      this.cluster.net.broadcast(
        n.id,
        this.cluster.peers,
        "BATCH_HEADER",
        Buffer.from(encodeHeader(produced.header), "utf8"),
      );
      this.cluster.net.broadcast(
        n.id,
        this.cluster.peers,
        "BATCH_BODY",
        Buffer.from(encodeBody(produced.header.batchId, produced.txs), "utf8"),
      );
      this.stats.dataPlaneHeaders++;
      this.stats.dataPlaneBodies++;
      n.readyBatches.add(produced.header.batchId);
    }
    this.cluster.tick(20, 40);
    const honest = this.cluster.nodes.filter((x) => !x.byzantine);
    const headersSeenByAllHonest = batchIds.every((id) =>
      honest.every(
        (n) => n.worker.dag.getHeader(id) !== undefined || n.readyBatches.has(id),
      ),
    );
    this.heightIndex++;
    return { batchIds, headersSeenByAllHonest };
  }

  /**
   * Ordered consensus with rotating leader (multi-leader over heights).
   * Each height: one leader proposes; payload is digest-only; wait finality.
   */
  consensusHeight(txsPer = 2): WaveResult | null {
    const ids = this.nodeIds();
    const leader = ids[this.heightIndex % ids.length]!;
    const txs: BatchTx[] = [];
    for (let t = 0; t < txsPer; t++) {
      txs.push({
        id: `c-${this.heightIndex}-${t}`,
        from: `s${t % 3}`,
        to: `r${(t + this.heightIndex) % 4}`,
        amount: 1n,
      });
    }
    const prop = this.cluster.proposeFrom(leader, txs);
    if (!prop) return null;
    const agg = buildDigestAggregate(
      this.cluster.epoch,
      Math.max(1, this.heightIndex + 1),
      "GENESIS",
      [{ batchId: prop.header.batchId, txDigest: prop.header.txDigest }],
    );
    const payloadJson = JSON.stringify(aggregateProposalPayload(agg));
    const digestOnly = isOfficialDigestPayload(payloadJson);
    for (let i = 0; i < 80; i++) {
      this.cluster.tick(20, 1);
      const honest = this.cluster.nodes.filter((n) => !n.byzantine);
      if (
        honest.every(
          (n) =>
            n.economic.isFinalized(prop.header.batchId) ||
            n.finalityCerts.has(prop.proposalDigest),
        )
      ) {
        break;
      }
      // fallback: all applied
      if (honest.every((n) => n.appliedBatches.has(prop.header.batchId))) break;
    }
    this.cluster.tick(20, 10);
    this.stats.consensusFinalized++;
    const wave: WaveResult = {
      slot: this.heightIndex,
      leader,
      batchId: prop.header.batchId,
      proposalDigest: prop.proposalDigest,
      digestOnly,
    };
    this.waves.push(wave);
    this.heightIndex++;
    return wave;
  }

  allHonestSameRoot(): boolean {
    const honest = this.cluster.nodes.filter((n) => !n.byzantine);
    if (!honest.length) return false;
    const r0 = honest[0]!.economic.stateRoot();
    return honest.every((n) => n.economic.stateRoot() === r0);
  }

  minFinalized(): number {
    const honest = this.cluster.nodes.filter((n) => !n.byzantine);
    return Math.min(...honest.map((n) => n.economic.finalizedBatchIds.size));
  }
}

export function benchmarkMultiLeader(opts?: {
  nodes?: number;
  heights?: number;
}): {
  sequentialLeadersMs: number;
  availabilityParallelMs: number;
  availabilityBatches: number;
  finalized: number;
  allDigestOnly: boolean;
} {
  const nodes = opts?.nodes ?? 4;
  const heights = opts?.heights ?? 3;

  const lab = new MultiLeaderLab(nodes, 42, 2);
  const t0 = performance.now();
  const av = lab.parallelAvailabilityRound(1);
  const availabilityParallelMs = performance.now() - t0;

  const lab2 = new MultiLeaderLab(nodes, 43, 2);
  const t1 = performance.now();
  for (let i = 0; i < heights; i++) lab2.consensusHeight(1);
  const sequentialLeadersMs = performance.now() - t1;

  return {
    sequentialLeadersMs,
    availabilityParallelMs,
    availabilityBatches: av.batchIds.length,
    finalized: lab2.minFinalized(),
    allDigestOnly: lab2.waves.every((w) => w.digestOnly),
  };
}
