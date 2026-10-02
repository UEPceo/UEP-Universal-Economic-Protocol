import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  leadersForSlot,
  MultiLeaderLab,
  benchmarkMultiLeader,
} from "./uep36-multi-leader.ts";
import {
  isDigestOnlyProposalPayload,
  buildDigestAggregate,
  aggregateProposalPayload,
} from "./uep36-digest-agg.ts";

describe("UEP-36.0 multi-leader + data/consensus plane", () => {
  it("leadersForSlot rotates deterministically", () => {
    const ids = ["mn-0", "mn-1", "mn-2", "mn-3"];
    assert.deepEqual(leadersForSlot(ids, 0, 2), ["mn-0", "mn-1"]);
    assert.deepEqual(leadersForSlot(ids, 2, 2), ["mn-2", "mn-3"]);
  });

  it("official DIGEST_AGGREGATE is the only digest-only proposal format", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b", txDigest: "d" },
    ]);
    const json = JSON.stringify(aggregateProposalPayload(agg));
    assert.equal(isDigestOnlyProposalPayload(json), true);
    // Legacy single-batch with execution stateRoot is NOT official
    assert.equal(
      isDigestOnlyProposalPayload(
        JSON.stringify({
          batchId: "b",
          txDigest: "d",
          stateRoot: "r",
          epoch: 0,
          height: 1,
        }),
      ),
      false,
    );
  });

  it("parallel data-plane availability: 2 leaders, headers reach honest nodes", () => {
    const lab = new MultiLeaderLab(4, 36, 2);
    const av = lab.parallelAvailabilityRound(1);
    assert.equal(av.batchIds.length, 2);
    assert.equal(av.headersSeenByAllHonest, true);
  });

  it("rotating multi-leader consensus heights → same root + digest-only", () => {
    const lab = new MultiLeaderLab(4, 37, 2);
    const w0 = lab.consensusHeight(1);
    const w1 = lab.consensusHeight(1);
    assert.ok(w0 && w1);
    assert.notEqual(w0.leader, w1.leader);
    assert.equal(w0.digestOnly, true);
    assert.equal(w1.digestOnly, true);
    assert.equal(lab.allHonestSameRoot(), true);
    assert.ok(lab.minFinalized() >= 2);
  });

  it("three heights with rotating leaders stay consistent", () => {
    const lab = new MultiLeaderLab(4, 38, 2);
    for (let i = 0; i < 3; i++) assert.ok(lab.consensusHeight(1));
    assert.equal(lab.allHonestSameRoot(), true);
    assert.equal(lab.minFinalized() >= 3, true);
    assert.ok(lab.waves.every((w) => w.digestOnly));
    assert.ok(new Set(lab.waves.map((w) => w.leader)).size >= 2);
  });

  it("LAB benchmark runs", () => {
    const b = benchmarkMultiLeader({ nodes: 4, heights: 2 });
    assert.equal(b.allDigestOnly, true);
    assert.ok(b.availabilityBatches >= 2);
    assert.ok(b.finalized >= 2);
  });
});
