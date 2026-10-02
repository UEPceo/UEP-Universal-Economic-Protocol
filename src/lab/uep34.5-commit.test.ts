import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bootCommitLab,
  tryConflictingProposals,
  tryConflictingQcDissemination,
} from "./uep34-commit-lab.ts";
import { ProposalBoard, VoteBoard } from "./uep34-commit-cert.ts";
import { createNodeIdentity } from "./node-identity.ts";
import {
  proposalFromEnvelope,
  signCommitVote,
  assembleCommitCert,
  verifyCommitCert,
} from "./uep34-commit-cert.ts";
import { LabNode, NODE_PROTOCOL_VERSION, signEnvelope } from "./node-protocol.ts";

describe("UEP-34.5 commit certificates", () => {
  it("conflicting proposals at same seq: second rejected (E9 class)", () => {
    const board = new ProposalBoard();
    const r = tryConflictingProposals(board, "leader-1");
    assert.equal(r.first, true);
    assert.equal(r.second, false);
    assert.equal(r.reason, "LEADER_EQUIVOCATION");
    assert.ok(board.equivocations.length >= 1);
  });

  it("conflicting QC vote dissemination: second rejected (E4 class)", () => {
    const board = new VoteBoard();
    const r = tryConflictingQcDissemination(board, ["a", "b", "c"], 1);
    assert.equal(r.first, true);
    assert.equal(r.second, false);
    assert.equal(r.reason, "VOTE_EQUIVOCATION");
  });

  it("commit lab: transition + failover + second transition", () => {
    const lab = bootCommitLab({ n: 4 });
    const c1 = lab.commitTransition({
      newStateRoot: "R1",
      transitionId: "t1",
      nullifier: "n1",
    });
    assert.equal(c1.ok, true, (c1 as { error?: string }).error);
    const fo = lab.failoverWithQuorum();
    assert.equal(fo.ok, true, fo.error);
    const c2 = lab.commitTransition({
      newStateRoot: "R2",
      transitionId: "t2",
      nullifier: "n2",
    });
    assert.equal(c2.ok, true, (c2 as { error?: string }).error);
    assert.ok(lab.nodes.every((n) => n.lab.stateRoot === "R2"));
  });

  it("commit lab: second root at same sequence fails", () => {
    const lab = bootCommitLab({ n: 4 });
    assert.equal(
      lab.commitTransition({
        newStateRoot: "A",
        transitionId: "ta",
        nullifier: "na",
      }).ok,
      true,
    );
    // Manually craft conflicting proposal registration
    const leader = lab.nodes.find((n) => n.id.nodeId === lab.leaderId())!;
    const env = leader.lab.propose({
      previousStateRoot: leader.lab.stateRoot,
      newStateRoot: "EVIL",
      transitionId: "evil",
      nullifier: "ne",
    });
    // Force same sequence by adjusting — propose increments sequence, so register
    // a hand-built conflict on seq already used
    const prop = proposalFromEnvelope(env);
    // Poison by registering alternate digest for same leader:seq of first commit
    const fake = {
      ...prop,
      digest: "other-digest",
      sequence: 1,
      newStateRoot: "FORK",
      leaderNodeId: leader.id.nodeId,
    };
    // First seq=1 already on board from c1
    const r = lab.proposalBoard.register(fake);
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "LEADER_EQUIVOCATION");
  });

  it("CommitCert requires quorum of candidates", () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`x${i}`));
    const leader = ids[0]!;
    const lab = new LabNode(
      leader,
      "local",
      1,
      leader.publicKeyHex,
      leader.nodeId,
    );
    const env = lab.propose({
      previousStateRoot: "GENESIS",
      newStateRoot: "R",
      transitionId: "t",
      nullifier: "n",
    });
    const prop = proposalFromEnvelope(env);
    const board = new ProposalBoard();
    assert.equal(board.register(prop).ok, true);
    // only 1 vote, need 3 for n=4
    const votes = [signCommitVote(ids[0]!, prop.digest)];
    const cert = assembleCommitCert(prop, votes);
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const r = verifyCommitCert(
      cert,
      ids.map((x) => x.nodeId),
      (id) => keys[id],
      board,
    );
    assert.equal(r.ok, false);
  });
});
