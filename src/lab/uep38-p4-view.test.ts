import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { P4ViewLab, P4_VIEW_VERSION, p4Leader } from "./uep38-p4-view.ts";
import { P4_QUORUM_NEED } from "./uep38-p4-quorum.ts";

describe("UEP-38.17 P4 view-change", () => {
  it("version and schedule", () => {
    assert.equal(P4_VIEW_VERSION, "38.17");
    const ids = ["q0", "q1", "q2", "q3"];
    assert.equal(p4Leader(ids, 1, 0), "q0");
    assert.equal(p4Leader(ids, 1, 1), "q1");
    assert.equal(p4Leader(ids, 1, 2), "q2");
  });

  it("cannot adopt view without QC of 3", () => {
    const v = new P4ViewLab();
    const one = v.voteViewChange(v.lab.replicas[0]!.identity, 1);
    const r = v.adoptView(1, [one]);
    assert.equal(r.ok, false);
    assert.equal(v.view, 0);
    assert.equal(v.leader(), "q0");
  });

  it("3 view-change votes rotate leader; new leader may propose", () => {
    const v = new P4ViewLab();
    assert.equal(v.canPropose("q0"), true);
    assert.equal(v.canPropose("q1"), false);
    const votes = v.lab.replicas.slice(0, 3).map((r) => v.voteViewChange(r.identity, 1));
    assert.ok(votes.length >= P4_QUORUM_NEED);
    const r = v.adoptView(1, votes);
    assert.equal(r.ok, true, r.reason);
    assert.equal(v.view, 1);
    assert.equal(v.leader(), "q1");
    assert.equal(v.canPropose("q0"), false);
    assert.equal(v.canPropose("q1"), true);
    const env = v.lab.buildProposal(1000n, 1);
    const ballots = v.lab.replicas.map((rep) => v.lab.vote(env, rep)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    assert.ok(ballots.length >= 3);
    assert.equal(v.lab.commit(env, ballots).ok, true);
    v.onCommittedHeight(1);
    assert.equal(v.height, 2);
    assert.equal(v.view, 0);
    assert.equal(v.leader(), "q1");
  });
});
