import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import { createNodeIdentity } from "./node-identity.ts";

function txs(n: number): BatchTx[] {
  const out: BatchTx[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `tx-${i}`,
      from: `s${i % 3}`,
      to: `r${i % 4}`,
      amount: 1n,
    });
  }
  return out;
}

describe("UEP-35.7 multi-node foundation", () => {
  it("4 independent nodes: propose → header → body recovery → converge", () => {
    const c = new MultiNodeCluster(4, 42);
    const prop = c.proposeFrom(c.nodes[0]!.id, txs(5));
    assert.ok(prop);
    c.tick(25, 50);
    assert.equal(c.allHonestDagConverged(), true);
    for (const n of c.nodes) {
      assert.ok(n.readyBatches.has(prop!.header.batchId));
    }
  });

  it("invalid signature header rejected by honest nodes", () => {
    const c = new MultiNodeCluster(3, 7);
    const prop = c.proposeFrom(c.nodes[0]!.id, txs(2));
    assert.ok(prop);
    const peer = c.nodes[1]!;
    const forged = {
      ...prop!.header,
      producerSignature: "ab".repeat(64),
    };
    const r = peer.worker.announceHeader(forged, true, peer.registry);
    assert.equal(r.ok, false);
  });

  it("partition then heal: honest convergence", () => {
    const c = new MultiNodeCluster(4, 99);
    c.net.partition(
      [c.nodes[0]!.id, c.nodes[1]!.id],
      [c.nodes[2]!.id, c.nodes[3]!.id],
    );
    c.proposeFrom(c.nodes[0]!.id, txs(3));
    c.tick(30, 15);
    // partition: not all must have batch
    c.net.heal();
    c.tick(30, 40);
    // after heal + enough time, re-propose recovery: body requests may need second wave
    // force rebroadcast header from producer if still local
    const h = c.nodes[0]!.worker.dag.getHeader([...c.nodes[0]!.readyBatches][0]!);
    if (h) {
      const payload = Buffer.from(JSON.stringify(h), "utf8");
      c.net.broadcast(c.nodes[0]!.id, c.peers, "BATCH_HEADER", payload);
    }
    c.tick(30, 40);
    assert.equal(c.allHonestDagConverged(), true);
  });

  it("scale message stats 8 nodes (LAB)", () => {
    const c = new MultiNodeCluster(8, 3);
    c.proposeFrom(c.nodes[0]!.id, txs(10));
    c.tick(25, 40);
    assert.ok(c.net.stats.sent > 0);
    assert.ok(c.net.stats.delivered > 0);
    // headers + body req/resp — not full mesh body flood for consensus
    assert.ok(c.net.stats.bytes > 0);
  });

  it("byzantine node does not block honest DAG", () => {
    const c = new MultiNodeCluster(4, 11, { byzantineIds: ["mn-3"] });
    c.proposeFrom(c.nodes[0]!.id, txs(4));
    c.tick(30, 40);
    const honest = c.nodes.filter((n) => !n.byzantine);
    const d0 = c.dagDigest(honest[0]!.id);
    assert.ok(honest.every((n) => c.dagDigest(n.id) === d0));
  });
});
