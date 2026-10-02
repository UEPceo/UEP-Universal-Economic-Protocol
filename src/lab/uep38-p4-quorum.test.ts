import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findBundledUepZk } from "./uep-zk-runner.ts";
import {
  P4QuorumLab,
  P4_QUORUM_NEED,
  P4_QUORUM_VERSION,
} from "./uep38-p4-quorum.ts";

describe("UEP-38.8 P4 quorum before apply", () => {
  it("version", () => {
    assert.equal(P4_QUORUM_VERSION, "38.21");
    assert.equal(P4_QUORUM_NEED, 3);
    assert.ok(findBundledUepZk());
  });

  it("no apply without 3 votes", () => {
    const lab = new P4QuorumLab(4);
    const before = lab.replicas.map((r) => r.state.stateRoot());
    const env = lab.buildProposal(1000n, 1);
    assert.deepEqual(lab.replicas.map((r) => r.state.stateRoot()), before);
    const one = lab.vote(env, lab.replicas[0]!);
    assert.ok(one);
    const c = lab.commit(env, [one]);
    assert.equal(c.ok, false);
    assert.match(c.reason ?? "", /NO_QUORUM/);
    assert.deepEqual(lab.replicas.map((r) => r.state.stateRoot()), before);
  });

  it("3 honest votes → all four apply same root", () => {
    const lab = new P4QuorumLab(4);
    const before = lab.replicas[0]!.state.stateRoot();
    const env = lab.buildProposal(1000n, 1);
    const votes = lab.replicas.map((r) => lab.vote(env, r)).filter((v) => v !== null);
    assert.ok(votes.length >= 2);
    const c = lab.commit(env, votes);
    assert.equal(c.ok, true, c.reason);
    const roots = lab.replicas.map((r) => r.state.stateRoot());
    assert.ok(roots.every((x) => x === roots[0]));
    assert.notEqual(roots[0], before);
  });
});
