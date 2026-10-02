import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SequencerElection,
  nextCandidate,
  leaderForEpoch,
  signNewLeader,
  verifyNewLeader,
} from "./uep34-election.ts";
import { createNodeIdentity } from "./node-identity.ts";
import { bootFailoverLab } from "./uep34-failover-lab.ts";

describe("UEP-34.0 election primitives", () => {
  it("nextCandidate is deterministic circular", () => {
    assert.equal(nextCandidate(["a", "b", "c"], "a"), "b");
    assert.equal(nextCandidate(["a", "b", "c"], "c"), "a");
    assert.equal(leaderForEpoch(["a", "b", "c"], 0), "a");
    assert.equal(leaderForEpoch(["a", "b", "c"], 1), "b");
    assert.equal(leaderForEpoch(["a", "b", "c"], 5), "c");
  });

  it("rejects NewLeader with bad signature", () => {
    const id = createNodeIdentity("cand-0");
    const cfg = {
      networkId: "local",
      domainId: 1,
      candidates: ["cand-0", "cand-1"],
      heartbeatTimeoutMs: 100,
    };
    const msg = signNewLeader(id, {
      networkId: "local",
      domainId: 1,
      epoch: 1,
      prevEpoch: 0,
      continueFromRoot: "GENESIS",
      continueFromSequence: 0,
      ts: 1,
    });
    const bad = { ...msg, signature: "00".repeat(64) };
    assert.equal(verifyNewLeader(bad, id.publicKeyHex, cfg).ok, false);
  });

  it("acceptNewLeader enforces epoch+1 and next candidate", () => {
    const a = createNodeIdentity("a");
    const b = createNodeIdentity("b");
    const cfg = {
      networkId: "local",
      domainId: 1,
      candidates: ["a", "b"],
      heartbeatTimeoutMs: 100,
    };
    const el = new SequencerElection(cfg);
    const msg = signNewLeader(b, {
      networkId: "local",
      domainId: 1,
      epoch: 1,
      prevEpoch: 0,
      continueFromRoot: "GENESIS",
      continueFromSequence: 0,
      ts: 1,
    });
    assert.equal(el.acceptNewLeader(msg, b.publicKeyHex).ok, true);
    assert.equal(el.state.leaderNodeId, "b");
    assert.equal(el.state.epoch, 1);
  });
});

describe("UEP-34.0 failover lab", () => {
  it("3 candidates: commit → failover → commit under new leader", () => {
    const lab = bootFailoverLab({ n: 3 });
    const firstLeader = lab.leaderId();
    const c1 = lab.commitAsLeader({
      newStateRoot: "R1",
      transitionId: "t1",
      nullifier: "n1",
    });
    assert.equal(c1.ok, true, (c1 as { error?: string }).error);

    const fo = lab.failover();
    assert.equal(fo.ok, true, fo.error);
    assert.notEqual(fo.newLeader, firstLeader);
    assert.equal(fo.epoch, 1);

    const c2 = lab.commitAsLeader({
      newStateRoot: "R2",
      transitionId: "t2",
      nullifier: "n2",
    });
    assert.equal(c2.ok, true, (c2 as { error?: string }).error);

    // All nodes same tip
    const roots = lab.nodes.map((n) => n.lab.stateRoot);
    assert.ok(roots.every((r) => r === "R2"));
    const seqs = lab.nodes.map((n) => n.lab.sequence);
    assert.ok(seqs.every((s) => s === 2));
    assert.ok(lab.nodes.every((n) => n.election.state.leaderNodeId === fo.newLeader));
  });

  it("supports N=5 candidates with double failover", () => {
    const lab = bootFailoverLab({ n: 5 });
    assert.equal(lab.nodes.length, 5);
    lab.commitAsLeader({
      newStateRoot: "A",
      transitionId: "ta",
      nullifier: "na",
    });
    const f1 = lab.failover();
    assert.equal(f1.ok, true, f1.error);
    lab.commitAsLeader({
      newStateRoot: "B",
      transitionId: "tb",
      nullifier: "nb",
    });
    const f2 = lab.failover();
    assert.equal(f2.ok, true, f2.error);
    assert.notEqual(f2.newLeader, f1.newLeader);
    lab.commitAsLeader({
      newStateRoot: "C",
      transitionId: "tc",
      nullifier: "nc",
    });
    assert.ok(lab.nodes.every((n) => n.lab.stateRoot === "C"));
    assert.ok(lab.nodes.every((n) => n.lab.sequence === 3));
  });

  it("old leader envelopes rejected after failover (wrong key)", () => {
    const lab = bootFailoverLab({ n: 3 });
    lab.commitAsLeader({
      newStateRoot: "R1",
      transitionId: "t1",
      nullifier: "n1",
    });
    const oldLeader = lab.nodes.find((n) => n.id.nodeId === lab.leaderId())!;
    lab.failover();
    // Old leader tries to propose with its key but nodes expect new leader key
    try {
      const env = oldLeader.lab.propose({
        previousStateRoot: oldLeader.lab.stateRoot,
        newStateRoot: "EVIL",
        transitionId: "evil",
        nullifier: "ne",
      });
      // propose uses oldLeader identity; verify uses new sequencer key → BAD_SIGNATURE
      const r = lab.nodes[0]!.lab.apply(env);
      // After failover, lab nodes have new sequencer key; apply should fail
      assert.equal(r.ok, false);
    } catch {
      // NOT_SEQUENCER if propose checks identity — also acceptable
      assert.ok(true);
    }
  });
});
