import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDigestAggregate,
  aggregateProposalPayload,
  isDigestOnlyAggregatePayload,
  verifyAggregateIntegrity,
} from "./uep36-digest-agg.ts";
import {
  parallelWaveApply,
  executeOrderedBatches,
} from "./uep36-parallel-exec.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import { MultiLeaderLab } from "./uep36-multi-leader.ts";
import { ProcessCluster } from "./uep35-process-cluster.ts";

function txsNonConflict(): BatchTx[] {
  // disjoint accounts → ideally 1 wave
  return [
    { id: "a", from: "s0", to: "r0", amount: 1n },
    { id: "b", from: "s1", to: "r1", amount: 1n },
    { id: "c", from: "s2", to: "r2", amount: 1n },
  ];
}

function txsConflict(): BatchTx[] {
  return [
    { id: "a", from: "s0", to: "r0", amount: 1n },
    { id: "b", from: "s0", to: "r1", amount: 1n }, // conflicts on s0
    { id: "c", from: "s1", to: "r2", amount: 1n },
  ];
}

describe("UEP-36.1 digest aggregate + parallel exec + process multi-leader", () => {
  it("build + verify digest aggregate; proposal remains digest-only", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b1", txDigest: "d1" },
      { batchId: "b2", txDigest: "d2" },
    ]);
    assert.equal(verifyAggregateIntegrity(agg), true);
    const payload = JSON.stringify(aggregateProposalPayload(agg));
    assert.equal(isDigestOnlyAggregatePayload(payload), true);
    assert.equal(payload.includes('"txs"'), false);
  });

  it("tampered aggregate fails integrity", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b1", txDigest: "d1" },
    ]);
    agg.entries.push({ batchId: "evil", txDigest: "x" });
    assert.equal(verifyAggregateIntegrity(agg), false);
  });

  it("parallel waves ≡ sequential root (non-conflicting)", () => {
    const initial = new LocalEconomicState({
      s0: 1000n,
      s1: 1000n,
      s2: 1000n,
      r0: 0n,
      r1: 0n,
      r2: 0n,
    });
    const r = parallelWaveApply(initial, txsNonConflict());
    assert.equal(r.rootsMatch, true);
    assert.equal(r.waveCount, 1);
    assert.equal(r.txCount, 3);
  });

  it("conflicting txs produce multiple waves but same root", () => {
    const initial = new LocalEconomicState({
      s0: 1000n,
      s1: 1000n,
      r0: 0n,
      r1: 0n,
      r2: 0n,
    });
    const r = parallelWaveApply(initial, txsConflict());
    assert.equal(r.rootsMatch, true);
    assert.ok(r.waveCount >= 2);
  });

  it("executeOrderedBatches preserves sequential ≡ parallel", () => {
    const initial = new LocalEconomicState({
      s0: 1000n,
      s1: 1000n,
      s2: 1000n,
      r0: 0n,
      r1: 0n,
      r2: 0n,
    });
    const r = executeOrderedBatches(initial, [
      { batchId: "b1", txs: [txsNonConflict()[0]!] },
      { batchId: "b2", txs: [txsNonConflict()[1]!, txsNonConflict()[2]!] },
    ]);
    assert.equal(r.rootsMatch, true);
  });

  it("in-process multi-leader still converges after 36.0 globalSeq", () => {
    const lab = new MultiLeaderLab(4, 61, 2);
    assert.ok(lab.consensusHeight(1));
    assert.ok(lab.consensusHeight(1));
    assert.equal(lab.allHonestSameRoot(), true);
    assert.ok(lab.minFinalized() >= 2);
  });

  it("process path: rotating multi-leader propose mn-0 then mn-1 → same root", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      // Official digest-only aggregate path (plain proposals are not accepted by peers).
      await cluster.proposeAggregate("mn-0", [
        [{ id: "ml-0", from: "s0", to: "r0", amount: "1" }],
      ]);
      let ok1 = false;
      for (let i = 0; i < 40; i++) {
        const st = await cluster.pollStatus();
        if (st.every((s) => s.finalized.length >= 1)) {
          ok1 = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(ok1, true);

      await cluster.proposeAggregate("mn-1", [
        [{ id: "ml-1", from: "s1", to: "r1", amount: "1" }],
      ]);
      let ok2 = false;
      for (let i = 0; i < 50; i++) {
        const st = await cluster.pollStatus();
        if (
          st.every((s) => s.finalized.length >= 2) &&
          new Set(st.map((s) => s.stateRoot)).size === 1
        ) {
          ok2 = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.equal(ok2, true, "second leader height must finalize on all processes");
    } finally {
      await cluster.stop();
    }
  });
});
