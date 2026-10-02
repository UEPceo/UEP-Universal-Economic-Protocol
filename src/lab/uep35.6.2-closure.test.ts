import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeBatchId,
  batchIdCollisionCheck,
  BATCH_ID_SEMANTICS,
} from "./uep35-batch-id.ts";
import {
  partitionByConflictGraphIndexed,
  partitionByConflictGraphLegacy,
  validateWaves,
  countConflictEdgesIndexed,
} from "./uep35-conflict-graph.ts";
import {
  sequentialExecution,
  parallelExecution,
  snapshotsEqual,
} from "./uep35-batch-execute.ts";
import { UepWorker } from "./uep35-worker.ts";
import {
  createNodeIdentity,
  NodeRegistry,
  registryFromIdentity,
} from "./node-identity.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import {
  SimulatedLink,
  LinkedAdapter,
  DtnBridge,
} from "./uep-net-adapt/dtn-bridge.ts";

function makeTxs(n: number, accounts: number): BatchTx[] {
  const txs: BatchTx[] = [];
  for (let i = 0; i < n; i++) {
    const from = i % accounts;
    let to = (i * 7 + 3) % accounts;
    if (to === from) to = (to + 1) % accounts;
    txs.push({ id: `t${i}`, from: `a${from}`, to: `a${to}`, amount: 1n });
  }
  return txs;
}

describe("UEP-35.6.2 closure", () => {
  it("BatchId semantics: content identity not state root", () => {
    assert.equal(BATCH_ID_SEMANTICS.identifies, "content_availability");
    const base = {
      workerId: "w",
      epoch: 0,
      height: 1,
      parents: [] as string[],
      txDigest: "abc",
      txCount: 1,
      byteSize: 10,
    };
    const a = computeBatchId(base);
    const b = computeBatchId({ ...base, height: 2 });
    assert.notEqual(a, b);
    assert.equal(batchIdCollisionCheck(base, { ...base, epoch: 1 }), false);
    assert.equal(batchIdCollisionCheck(base, { ...base, workerId: "other" }), false);
    assert.equal(batchIdCollisionCheck(base, { ...base, txDigest: "zzz" }), false);
  });

  it("producer registry binding ACCEPT/REJECT", () => {
    const id = createNodeIdentity("prod-1");
    const wrong = createNodeIdentity("prod-1"); // same id different key
    const reg = new NodeRegistry();
    reg.register(
      registryFromIdentity(id, {
        networkId: "lab",
        domainId: 1,
        role: "sequencer",
      }),
    );
    const w = new UepWorker({ workerId: id.nodeId, epoch: 0, identity: id });
    w.admit({ id: "t", from: "a", to: "b", amount: 1n });
    const p = w.produceBatch()!;
    const peer = new UepWorker({ workerId: "peer", epoch: 0 });
    assert.equal(peer.announceHeader(p.header, true, reg).ok, true);
    // wrong key on header
    const badKey = { ...p.header, producerPublicKeyHex: wrong.publicKeyHex };
    assert.equal(peer.announceHeader(badKey, true, reg).ok, false);
    // unknown producer
    const unknown = createNodeIdentity("ghost");
    const w2 = new UepWorker({
      workerId: unknown.nodeId,
      epoch: 0,
      identity: unknown,
    });
    w2.admit({ id: "t2", from: "a", to: "b", amount: 1n });
    const p2 = w2.produceBatch()!;
    assert.equal(peer.announceHeader(p2.header, true, reg).ok, false);
  });

  it("invariants A–H", async () => {
    const txs = makeTxs(25, 6);
    const idx = partitionByConflictGraphIndexed(txs);
    const leg = partitionByConflictGraphLegacy(txs);
    assert.equal(validateWaves(txs, idx).ok, true);
    assert.equal(validateWaves(txs, leg).ok, true);
    // A: each once
    assert.equal(idx.flat().length, txs.length);
    // B: no intra conflicts covered by validateWaves
    // C: both valid
    // D: seq == par
    const accounts = Array.from({ length: 6 }, (_, i) => ({
      label: `a${i}`,
      balance: 5000n,
    }));
    const seq = await sequentialExecution(accounts, txs);
    const par = await parallelExecution(accounts, txs);
    assert.equal(snapshotsEqual(seq.snapshot, par.snapshot), true);
    // E: wrong body
    const w = new UepWorker({ workerId: "w", epoch: 0 });
    w.admit(txs[0]!);
    const prod = w.produceBatch()!;
    const peer = new UepWorker({ workerId: "p", epoch: 0 });
    peer.announceHeader(prod.header);
    const bad = [{ ...prod.txs[0]!, amount: 999n }];
    assert.equal(peer.ingestRecovery(prod.header, bad).ok, false);
    // F: HEADER_KNOWN without ready
    assert.equal(peer.dag.isHeaderKnown(prod.header.batchId), true);
    assert.equal(peer.dag.isReady(prod.header.batchId), false);
    // G/H: DTN transport ≠ delivered ≠ ack
    const link = new SimulatedLink();
    link.setUp(true);
    const a = new LinkedAdapter("A", link, "A");
    const b = new LinkedAdapter("B", link, "B");
    const dtn = new DtnBridge(a);
    const st = await dtn.send({
      id: "m",
      payload: new TextEncoder().encode("x"),
      createdAt: 1,
    });
    assert.equal(st, "ACCEPTED_BY_TRANSPORT");
    assert.notEqual(st, "DELIVERED");
    const got = await b.receive();
    assert.ok(got);
    dtn.markRemoteDelivered("m");
    assert.equal(dtn.getState("m"), "DELIVERED");
    dtn.acknowledge("m");
    assert.equal(dtn.getState("m"), "ACKNOWLEDGED");
    assert.ok(countConflictEdgesIndexed(txs) >= 0);
  });
});
