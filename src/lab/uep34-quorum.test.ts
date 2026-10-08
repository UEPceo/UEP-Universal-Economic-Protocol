import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeIdentity } from "./node-identity.ts";
import { signNewLeader, SequencerElection } from "./uep34-election.ts";
import {
  assembleQuorumCert,
  collectVotes,
  majorityThreshold,
  verifyQuorumCert,
  signVote,
  localFromElection,
} from "./uep34-quorum.ts";
import { bootFailoverLab } from "./uep34-failover-lab.ts";

describe("UEP-34.2/34.3 quorum certificates", () => {
  it("majorityThreshold", () => {
    assert.equal(majorityThreshold(3), 2);
    assert.equal(majorityThreshold(5), 3);
  });

  it("QC with majority verifies; single vote fails", () => {
    const a = createNodeIdentity("a");
    const b = createNodeIdentity("b");
    const c = createNodeIdentity("c");
    const cfg = {
      networkId: "local",
      domainId: 1,
      candidates: ["a", "b", "c"],
      heartbeatTimeoutMs: 100,
    };
    const proposal = signNewLeader(b, {
      networkId: "local",
      domainId: 1,
      epoch: 1,
      prevEpoch: 0,
      continueFromRoot: "GENESIS",
      continueFromSequence: 0,
      ts: 1,
    });
    const keys: Record<string, string> = {
      a: a.publicKeyHex,
      b: b.publicKeyHex,
      c: c.publicKeyHex,
    };
    const partial = {
      networkId: proposal.networkId,
      domainId: proposal.domainId,
      epoch: proposal.epoch,
      leaderNodeId: proposal.leaderNodeId,
      prevEpoch: proposal.prevEpoch,
      continueFromRoot: proposal.continueFromRoot,
      continueFromSequence: proposal.continueFromSequence,
      ts: proposal.ts,
    };
    const one = assembleQuorumCert(proposal, [signVote(b, partial)]);
    assert.equal(
      verifyQuorumCert(one, cfg, (id) => keys[id]).ok,
      false,
    );
    const maj = assembleQuorumCert(
      proposal,
      collectVotes([a, b, c], partial),
    );
    assert.equal(verifyQuorumCert(maj, cfg, (id) => keys[id]).ok, true);
  });

  it("conflicting QCs: second rejected via vote log", () => {
    const a = createNodeIdentity("a");
    const b = createNodeIdentity("b");
    const c = createNodeIdentity("c");
    const cfg = {
      networkId: "local",
      domainId: 1,
      candidates: ["a", "b", "c"],
      heartbeatTimeoutMs: 100,
    };
    const keys: Record<string, string> = {
      a: a.publicKeyHex,
      b: b.publicKeyHex,
      c: c.publicKeyHex,
    };
    const voteLog = new Map<string, Map<number, string>>();
    const local = {
      currentEpoch: 0,
      currentLeaderId: "a",
      lastSequence: 0,
      lastStateRoot: "GENESIS",
      voteLog,
    };
    const p1 = signNewLeader(b, {
      networkId: "local",
      domainId: 1,
      epoch: 1,
      prevEpoch: 0,
      continueFromRoot: "GENESIS",
      continueFromSequence: 0,
      ts: 1,
    });
    const p2 = signNewLeader(b, {
      networkId: "local",
      domainId: 1,
      epoch: 1,
      prevEpoch: 0,
      continueFromRoot: "OTHER-ROOT",
      continueFromSequence: 0,
      ts: 2,
    });
    const body = (p: typeof p1) => ({
      networkId: p.networkId,
      domainId: p.domainId,
      epoch: p.epoch,
      leaderNodeId: p.leaderNodeId,
      prevEpoch: p.prevEpoch,
      continueFromRoot: p.continueFromRoot,
      continueFromSequence: p.continueFromSequence,
      ts: p.ts,
    });
    const qc1 = assembleQuorumCert(p1, collectVotes([a, b, c], body(p1)));
    const qc2 = assembleQuorumCert(p2, collectVotes([a, b, c], body(p2)));
    assert.equal(
      verifyQuorumCert(qc1, cfg, (id) => keys[id], { local }).ok,
      true,
    );
    // Same voters already locked to p1 digest for epoch 1
    const r2 = verifyQuorumCert(qc2, cfg, (id) => keys[id], { local });
    assert.equal(r2.ok, false);
    assert.match((r2 as { reason: string }).reason, /EQUIVOCATION/);
  });

  it("rejects QC for future epoch vs local state", () => {
    const a = createNodeIdentity("a");
    const b = createNodeIdentity("b");
    const c = createNodeIdentity("c");
    const cfg = {
      networkId: "local",
      domainId: 1,
      candidates: ["a", "b", "c"],
      heartbeatTimeoutMs: 100,
    };
    const keys: Record<string, string> = {
      a: a.publicKeyHex,
      b: b.publicKeyHex,
      c: c.publicKeyHex,
    };
    const p = signNewLeader(b, {
      networkId: "local",
      domainId: 1,
      epoch: 50,
      prevEpoch: 49,
      continueFromRoot: "GENESIS",
      continueFromSequence: 0,
      ts: 1,
    });
    const partial = {
      networkId: p.networkId,
      domainId: p.domainId,
      epoch: p.epoch,
      leaderNodeId: p.leaderNodeId,
      prevEpoch: p.prevEpoch,
      continueFromRoot: p.continueFromRoot,
      continueFromSequence: p.continueFromSequence,
      ts: p.ts,
    };
    const cert = assembleQuorumCert(p, collectVotes([a, b, c], partial));
    const local = {
      currentEpoch: 0,
      currentLeaderId: "a",
      lastSequence: 0,
      lastStateRoot: "GENESIS",
      voteLog: new Map<string, Map<number, string>>(),
    };
    const r = verifyQuorumCert(cert, cfg, (id) => keys[id], { local });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "EPOCH_NOT_NEXT");
  });

  it("failoverWithQuorum then commit under new leader", () => {
    const lab = bootFailoverLab({ n: 3, mode: "LAB-QUORUM-FAILOVER" });
    lab.commitAsLeader({
      newStateRoot: "R1",
      transitionId: "t1",
      nullifier: "n1",
    });
    const fo = lab.failoverWithQuorum();
    assert.equal(fo.ok, true, fo.error);
    const c2 = lab.commitAsLeader({
      newStateRoot: "R2",
      transitionId: "t2",
      nullifier: "n2",
    });
    assert.equal(c2.ok, true, (c2 as { error?: string }).error);
    assert.ok(lab.nodes.every((n) => n.lab.stateRoot === "R2"));
  });

  it("quorum mode blocks simple acceptNewLeader / failover()", () => {
    const lab = bootFailoverLab({ n: 3, mode: "LAB-QUORUM-FAILOVER" });
    const r = lab.failover();
    assert.equal(r.ok, false);
    assert.equal(r.error, "QUORUM_REQUIRED");
  });

  it("prevEpoch mismatch rejected on accept", () => {
    const a = createNodeIdentity("a");
    const b = createNodeIdentity("b");
    const el = new SequencerElection({
      networkId: "local",
      domainId: 1,
      candidates: ["a", "b"],
      heartbeatTimeoutMs: 100,
      mode: "LAB-SIMPLE-FAILOVER",
    });
    const msg = signNewLeader(b, {
      networkId: "local",
      domainId: 1,
      epoch: 1,
      prevEpoch: 999,
      continueFromRoot: "GENESIS",
      continueFromSequence: 0,
      ts: 1,
    });
    const ar = el.acceptNewLeader(msg, b.publicKeyHex);
    assert.equal(ar.ok, false);
    assert.equal((ar as { reason: string }).reason, "PREV_EPOCH_MISMATCH");
  });

  it("forged QC votes rejected", () => {
    const lab = bootFailoverLab({ n: 3 });
    const leader = lab.nodes.find((n) => n.id.nodeId === lab.leaderId())!;
    const next = lab.nodes.find((n) => n.id.nodeId !== lab.leaderId())!;
    const msg = next.election.claimLeadership(
      next.id,
      leader.lab.stateRoot,
      leader.lab.sequence,
    );
    assert.ok(!("error" in msg));
    if ("error" in msg) return;
    const cert = assembleQuorumCert(msg, [
      { nodeId: next.id.nodeId, signature: "00".repeat(64) },
      { nodeId: leader.id.nodeId, signature: "11".repeat(64) },
    ] as unknown as Parameters<typeof assembleQuorumCert>[1]);
    const r = verifyQuorumCert(cert, lab.cfg, (id) =>
      lab.registry.publicKeyHex(id),
    );
    assert.equal(r.ok, false);
  });
});
