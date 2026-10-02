import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AggregateConsensusLab,
  aggregateTransitionDigest,
} from "./uep36-aggregate-consensus.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";
import { verifyCommitCert } from "./uep34-commit-cert.ts";
import { buildDigestAggregate } from "./uep36-digest-agg.ts";

function funded(): LocalEconomicState {
  const init: Record<string, bigint> = {};
  for (let i = 0; i < 8; i++) {
    init[`s${i}`] = 50_000n;
    init[`r${i}`] = 0n;
  }
  return new LocalEconomicState(init);
}

describe("UEP-36.3 DigestAggregate → CommitCert → Finality", () => {
  it("pipeline: aggregate → execute → CommitCert → apply", () => {
    const lab = new AggregateConsensusLab({ n: 4 });
    const initial = funded();
    const applyTo = initial.clone();
    const r = lab.run(
      initial,
      [
        {
          batchId: "b1",
          txs: [{ id: "t1", from: "s0", to: "r0", amount: 10n }],
        },
        {
          batchId: "b2",
          txs: [{ id: "t2", from: "s1", to: "r1", amount: 5n }],
        },
      ],
      { applyTo },
    );
    assert.equal(r.certVerified, true);
    assert.equal(r.applied, true);
    assert.equal(r.execution.fullStateEqual, true);
    assert.equal(applyTo.stateRoot(), r.newStateRoot);
    assert.equal(applyTo.sequence, 1);
    assert.ok(applyTo.isFinalized("b1"));
    assert.ok(applyTo.isFinalized("b2"));
    assert.equal(r.aggregate.entries.length, 2);
    assert.equal(r.commitCert.votes.length, 4);
  });

  it("proposal digest binds aggregateDigest and state roots", () => {
    const lab = new AggregateConsensusLab({ n: 4 });
    const initial = funded();
    const r = lab.run(initial, [
      {
        batchId: "b1",
        txs: [{ id: "t1", from: "s0", to: "r0", amount: 1n }],
      },
    ]);
    const d2 = aggregateTransitionDigest(
      r.aggregate,
      r.previousStateRoot,
      "DIFFERENT_ROOT",
      lab.networkId,
      lab.domainId,
      r.proposal.leaderNodeId,
    );
    assert.notEqual(d2, r.proposal.digest);
  });

  it("insufficient votes fails CommitCert", () => {
    const lab = new AggregateConsensusLab({ n: 4 });
    const initial = funded();
    const r = lab.run(initial, [
      {
        batchId: "b1",
        txs: [{ id: "t1", from: "s0", to: "r0", amount: 1n }],
      },
    ]);
    // Strip votes below quorum
    const weak = {
      ...r.commitCert,
      votes: r.commitCert.votes.slice(0, 1),
    };
    const vr = verifyCommitCert(
      weak,
      lab.candidateIds,
      lab.publicKeyOf,
      undefined,
      { bftProfile: "BFT-CLASSIC" },
    );
    assert.equal(vr.ok, false);
  });

  it("tampered aggregateDigest breaks proposal binding", () => {
    const lab = new AggregateConsensusLab({ n: 4 });
    const initial = funded();
    const r = lab.run(initial, [
      {
        batchId: "b1",
        txs: [{ id: "t1", from: "s0", to: "r0", amount: 1n }],
      },
    ]);
    const evilAgg = {
      ...r.aggregate,
      aggregateDigest: "ff".repeat(32),
    };
    const evilDigest = aggregateTransitionDigest(
      evilAgg,
      r.previousStateRoot,
      r.newStateRoot,
      lab.networkId,
      lab.domainId,
      r.proposal.leaderNodeId,
    );
    assert.notEqual(evilDigest, r.proposal.digest);
  });

  it("two heights chain with same lab", () => {
    const lab = new AggregateConsensusLab({ n: 4 });
    const state = funded();
    const r1 = lab.run(
      state,
      [
        {
          batchId: "h1",
          txs: [{ id: "a", from: "s0", to: "r0", amount: 1n }],
        },
      ],
      { applyTo: state },
    );
    assert.equal(r1.applied, true);
    const r2 = lab.run(
      state,
      [
        {
          batchId: "h2",
          txs: [{ id: "b", from: "s1", to: "r1", amount: 2n }],
        },
      ],
      { applyTo: state, leaderIndex: 1 },
    );
    assert.equal(r2.applied, true);
    assert.equal(state.sequence, 2);
    assert.equal(state.stateRoot(), r2.newStateRoot);
  });

  it("DigestAggregate alone is not finality", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "x", txDigest: "y".repeat(64) },
    ]);
    // Aggregate has no commit votes / finality fields
    assert.equal("commitCert" in agg, false);
    assert.equal(agg.version, "36.1.1");
  });
});
