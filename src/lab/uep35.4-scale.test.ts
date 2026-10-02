import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScalePipeline, BatchHeaderBus } from "./uep35-scale-pipeline.ts";
import { ScaleMempool, batchDigest } from "./uep35-scale-mempool.ts";
import { partitionBySender, type BatchTx } from "./uep35-batch-lab.ts";

describe("UEP-35.4 scale mempool + pipeline", () => {
  it("mempool admits, dedups, forms batches", () => {
    const mp = new ScaleMempool({ maxBatchSize: 10, maxPending: 100 });
    const txs: BatchTx[] = [];
    for (let i = 0; i < 25; i++) {
      txs.push({ id: `t${i}`, from: "a", to: "b", amount: 1n });
    }
    const r = mp.admitMany(txs);
    assert.equal(r.admitted, 25);
    assert.equal(mp.admit({ id: "t0", from: "a", to: "b", amount: 1n }).ok, false);
    const b1 = mp.takeBatch();
    assert.equal(b1.length, 10);
    const b2 = mp.takeBatch();
    assert.equal(b2.length, 10);
    const b3 = mp.takeBatch();
    assert.equal(b3.length, 5);
    assert.equal(mp.size(), 0);
  });

  it("parallel wave: many senders → fewer waves", () => {
    const txs: BatchTx[] = [];
    for (let i = 0; i < 50; i++) {
      txs.push({
        id: `p${i}`,
        from: `s${i}`,
        to: `r${i % 10}`,
        amount: 1n,
      });
    }
    const waves = partitionBySender(txs);
    assert.equal(waves.length, 1);
    assert.equal(waves[0]!.length, 50);
  });

  it("scale pipeline 500 TX: conservation + throughput report", async () => {
    const pipe = new ScalePipeline({
      accounts: 50,
      initialBalance: 10_000n,
      proveConcurrency: 8,
      mempool: { maxBatchSize: 64, maxPending: 10_000 },
    });
    const admitted = pipe.injectLoad(500, 1n);
    assert.equal(admitted, 500);
    const report = await pipe.drain(20);
    assert.ok(report.committed > 0, `committed=${report.committed}`);
    assert.equal(report.conservationOk, true, "value not conserved");
    assert.ok(report.txPerSec > 0);
    assert.ok(report.headers.length >= 1);
    // fees go to treasury; total accounts+treasury constant
    assert.equal(pipe.sumBalances(), report.totalValue);
  });

  it("batch header bus dedups propagation", () => {
    const bus = new BatchHeaderBus();
    const received: string[] = [];
    bus.subscribe("n1", (h) => received.push(h.digest));
    bus.subscribe("n2", (h) => received.push(h.digest));
    const txs: BatchTx[] = [
      { id: "1", from: "a", to: "b", amount: 1n },
    ];
    const digest = batchDigest(txs);
    const h = {
      batchId: "B1",
      digest,
      txCount: 1,
      waveHint: 1,
      ts: 1,
    };
    bus.publish(h);
    bus.publish(h); // duplicate
    assert.equal(bus.stats.published, 1);
    assert.equal(bus.stats.duplicates, 1);
    assert.equal(received.length, 2); // one per subscriber
  });

  it("1000 TX structural load smoke", async () => {
    const pipe = new ScalePipeline({
      accounts: 100,
      initialBalance: 50_000n,
      proveConcurrency: 8,
      mempool: { maxBatchSize: 128, maxPending: 20_000 },
    });
    pipe.injectLoad(1000, 1n);
    const report = await pipe.drain(50);
    assert.equal(report.conservationOk, true);
    assert.ok(report.committed >= 900, `committed=${report.committed} rej=${report.rejected}`);
    console.log(
      `UEP-35.4 scale: committed=${report.committed} wallMs=${report.wallMs.toFixed(1)} tx/s=${report.txPerSec.toFixed(0)} batches=${report.headers.length}`,
    );
  });
});
