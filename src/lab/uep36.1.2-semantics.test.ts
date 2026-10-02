import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parallelSafeScheduleApply,
  sameTxsDifferentValidSchedules,
} from "./uep36-parallel-exec.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import {
  buildDigestAggregate,
  isDigestOnlyAggregatePayload,
  aggregateProposalPayload,
} from "./uep36-digest-agg.ts";
import { partitionByConflictGraph, validateWaves as validateWavePart } from "./uep35-conflict-graph.ts";
import { runBench3612 } from "./uep36.1.2-benchmark.ts";

function funded(): LocalEconomicState {
  const init: Record<string, bigint> = {};
  for (let i = 0; i < 8; i++) {
    init[`s${i}`] = 100_000n;
    init[`r${i}`] = 0n;
  }
  return new LocalEconomicState(init);
}

describe("UEP-36.1.2 execution semantics + payload closure", () => {
  it("sequential original order ≡ scheduled waves (independent txs)", () => {
    const txs: BatchTx[] = [
      { id: "a", from: "s0", to: "r0", amount: 1n },
      { id: "b", from: "s1", to: "r1", amount: 2n },
      { id: "c", from: "s2", to: "r2", amount: 3n },
    ];
    const r = parallelSafeScheduleApply(funded(), txs);
    assert.equal(r.rootsMatch, true);
    assert.equal(r.fullStateEqual, true);
    assert.equal(r.sequentialHeight, 1);
    assert.equal(r.scheduledHeight, 1);
    assert.equal(r.waveCount, 1);
  });

  it("conflicts → multiple waves, still one height and same state", () => {
    const txs: BatchTx[] = [
      { id: "a", from: "s0", to: "r0", amount: 1n },
      { id: "b", from: "s0", to: "r1", amount: 1n },
      { id: "c", from: "s1", to: "r2", amount: 1n },
    ];
    const r = parallelSafeScheduleApply(funded(), txs);
    assert.ok(r.waveCount >= 2);
    assert.equal(r.sequentialHeight, r.scheduledHeight);
    assert.equal(r.sequentialHeight, 1);
    assert.equal(r.fullStateEqual, true);
    assert.equal(r.rootsMatch, true);
  });

  it("many waves still height +1 once", () => {
    const txs: BatchTx[] = [];
    for (let i = 0; i < 10; i++) {
      txs.push({ id: `t${i}`, from: "s0", to: `r${i % 4}`, amount: 1n });
    }
    const r = parallelSafeScheduleApply(funded(), txs);
    assert.ok(r.waveCount >= 2);
    assert.equal(r.scheduledHeight, 1);
    assert.equal(r.sequentialHeight, 1);
    assert.equal(r.fullStateEqual, true);
  });

  it("cross transfers + fees: full observable equality", () => {
    const txs: BatchTx[] = [
      { id: "a", from: "s0", to: "s1", amount: 10n },
      { id: "b", from: "s2", to: "r0", amount: 5n },
      { id: "c", from: "s3", to: "r1", amount: 7n },
    ];
    const r = parallelSafeScheduleApply(funded(), txs);
    assert.equal(r.fullStateEqual, true);
  });

  it("different valid wave partitions → same root and height", () => {
    const txs: BatchTx[] = [
      { id: "a", from: "s0", to: "r0", amount: 1n },
      { id: "b", from: "s1", to: "r1", amount: 1n },
      { id: "c", from: "s0", to: "r2", amount: 1n },
    ];
    const d = sameTxsDifferentValidSchedules(funded(), txs);
    assert.equal(d.equal, true);
    assert.equal(d.heightA, d.heightB);
    assert.equal(d.rootA, d.rootB);
  });

  it("wave coverage: no lost/dup txs; intra-wave conflict free", () => {
    const txs: BatchTx[] = [
      { id: "a", from: "s0", to: "r0", amount: 1n },
      { id: "b", from: "s0", to: "r1", amount: 1n },
      { id: "c", from: "r0", to: "s1", amount: 1n },
      { id: "d", from: "s2", to: "r2", amount: 1n },
    ];
    const waves = partitionByConflictGraph(txs);
    assert.equal(validateWavePart(txs, waves).ok, true);
  });

  it("adversarial amount change breaks equality", () => {
    const base: BatchTx[] = [
      { id: "a", from: "s0", to: "r0", amount: 1n },
      { id: "b", from: "s1", to: "r1", amount: 1n },
    ];
    const r1 = parallelSafeScheduleApply(funded(), base);
    const evil = base.map((t) =>
      t.id === "b" ? { ...t, amount: 99n } : t,
    );
    const r2 = parallelSafeScheduleApply(funded(), evil);
    assert.notEqual(r1.sequentialRoot, r2.sequentialRoot);
  });

  it("payload: missing fields / stateRoot / empty entries rejected", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b1", txDigest: "d1" },
    ]);
    const good = JSON.stringify(aggregateProposalPayload(agg));
    assert.equal(isDigestOnlyAggregatePayload(good), true);

    const bad1 = JSON.parse(good);
    delete bad1.version;
    assert.equal(isDigestOnlyAggregatePayload(JSON.stringify(bad1)), false);

    const bad2 = JSON.parse(good);
    bad2.stateRoot = "exec";
    assert.equal(isDigestOnlyAggregatePayload(JSON.stringify(bad2)), false);

    const bad3 = JSON.parse(good);
    bad3.entryDigests = [];
    assert.equal(isDigestOnlyAggregatePayload(JSON.stringify(bad3)), false);

    const bad4 = JSON.parse(good);
    bad4.aggregateDigest = "00".repeat(32);
    assert.equal(isDigestOnlyAggregatePayload(JSON.stringify(bad4)), false);
  });

  it("[b1,b2] and [b2,b1] same aggregateDigest", () => {
    const a = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b1", txDigest: "d1" },
      { batchId: "b2", txDigest: "d2" },
    ]);
    const b = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b2", txDigest: "d2" },
      { batchId: "b1", txDigest: "d1" },
    ]);
    assert.equal(a.aggregateDigest, b.aggregateDigest);
  });

  it("benchmark reproducible under same seed", () => {
    const x = runBench3612({ seed: 99, txCount: 40 });
    const y = runBench3612({ seed: 99, txCount: 40 });
    assert.equal(x.aggregateDigest, y.aggregateDigest);
    assert.equal(x.sequentialRoot, y.sequentialRoot);
    assert.equal(x.scheduledRoot, y.scheduledRoot);
    assert.equal(x.waves, y.waves);
    assert.equal(x.rootsMatch, true);
  });
});
