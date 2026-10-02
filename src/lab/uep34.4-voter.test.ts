import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeIdentity } from "./node-identity.ts";
import {
  Voter,
  buildDoubleVoteEvidence,
  verifyDoubleVoteEvidence,
} from "./uep34-voter.ts";
import { bftParamsFromN } from "./uep34-bft-params.ts";
import { bootFailoverLab } from "./uep34-failover-lab.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signVoteLegacy } from "./uep34-quorum.ts";

describe("UEP-34.4 real voter lock", () => {
  it("honest voter cannot sign two incompatible proposals same epoch", () => {
    const id = createNodeIdentity("v1");
    const voter = new Voter(id, "local", 1);
    const base = {
      networkId: "local",
      domainId: 1,
      epoch: 1,
      leaderNodeId: "cand-1",
      prevEpoch: 0,
      continueFromSequence: 0,
      ts: 1,
    };
    const a = voter.signVote({ ...base, continueFromRoot: "ROOT-A" });
    assert.equal(a.ok, true);
    const b = voter.signVote({ ...base, continueFromRoot: "ROOT-B" });
    assert.equal(b.ok, false);
    assert.equal((b as { reason: string }).reason, "ALREADY_LOCKED_OTHER_PROPOSAL");
    // same proposal again is ok (idempotent)
    const a2 = voter.signVote({ ...base, continueFromRoot: "ROOT-A" });
    assert.equal(a2.ok, true);
  });

  it("double-vote evidence verifies when attacker signs outside Voter", () => {
    const id = createNodeIdentity("evil");
    const pA = {
      networkId: "local",
      domainId: 1,
      epoch: 1,
      leaderNodeId: "L",
      prevEpoch: 0,
      continueFromRoot: "A",
      continueFromSequence: 0,
      ts: 1,
    };
    const pB = { ...pA, continueFromRoot: "B", ts: 2 };
    const vA = signVoteLegacy(id, pA);
    const vB = signVoteLegacy(id, pB);
    const ev = buildDoubleVoteEvidence(vA, pA, vB, pB);
    assert.ok(!("error" in ev));
    if ("error" in ev) return;
    assert.equal(verifyDoubleVoteEvidence(ev, id.publicKeyHex).ok, true);
  });

  it("voter lock survives persist/reload", () => {
    const id = createNodeIdentity("v2");
    const voter = new Voter(id, "local", 1);
    const p = {
      networkId: "local",
      domainId: 1,
      epoch: 3,
      leaderNodeId: "L",
      prevEpoch: 2,
      continueFromRoot: "R",
      continueFromSequence: 5,
      ts: 1,
    };
    assert.equal(voter.signVote(p).ok, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uep-voter-"));
    voter.save(dir);
    const voter2 = new Voter(id, "local", 1);
    voter2.load(dir);
    const bad = voter2.signVote({ ...p, continueFromRoot: "OTHER" });
    assert.equal(bad.ok, false);
  });

  it("bftParams: n=4 → f=1 quorum=3; n=7 → f=2 quorum=5", () => {
    assert.deepEqual(bftParamsFromN(4), {
      n: 4,
      f: 1,
      quorum: 3,
      classic: true,
    });
    assert.deepEqual(bftParamsFromN(7), {
      n: 7,
      f: 2,
      quorum: 5,
      classic: true,
    });
    assert.equal(bftParamsFromN(3).quorum, 2); // classic f=0? (3-1)%3=2 not 0
    // n=3: (3-1)%3=2 → not classic, majority 2
    assert.equal(bftParamsFromN(3).classic, false);
    assert.equal(bftParamsFromN(3).quorum, 2);
  });

});

describe("UEP-34.4 bft threshold n=4", () => {
  it("needs 3 votes of 4", async () => {
    const { createNodeIdentity } = await import("./node-identity.ts");
    const { signNewLeader } = await import("./uep34-election.ts");
    const {
      Voter,
      assembleQuorumCert,
      verifyQuorumCert,
      collectVotesFromVoters,
      majorityThreshold,
    } = await import("./uep34-quorum.ts");
    assert.equal(majorityThreshold(4), 3);
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`c${i}`));
    const voters = ids.map((id) => new Voter(id, "local", 1));
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const proposal = signNewLeader(ids[1]!, {
      networkId: "local",
      domainId: 1,
      epoch: 1,
      prevEpoch: 0,
      continueFromRoot: "GENESIS",
      continueFromSequence: 0,
      ts: 1,
    });
    const body = {
      networkId: proposal.networkId,
      domainId: proposal.domainId,
      epoch: proposal.epoch,
      leaderNodeId: proposal.leaderNodeId,
      prevEpoch: proposal.prevEpoch,
      continueFromRoot: proposal.continueFromRoot,
      continueFromSequence: proposal.continueFromSequence,
      ts: proposal.ts,
    };
    const two = collectVotesFromVoters(voters.slice(0, 2), body);
    assert.equal(two.ok, true);
    if (!two.ok) return;
    const cert2 = assembleQuorumCert(proposal, two.votes);
    const r2 = verifyQuorumCert(cert2, {
      networkId: "local",
      domainId: 1,
      candidates: ids.map((x) => x.nodeId),
      heartbeatTimeoutMs: 100,
    }, (id) => keys[id]);
    assert.equal(r2.ok, false);
    const all = collectVotesFromVoters(voters, body);
    // voters 0,1 already locked same proposal — ok
    assert.equal(all.ok, true);
    if (!all.ok) return;
    const certAll = assembleQuorumCert(proposal, all.votes);
    assert.equal(
      verifyQuorumCert(
        certAll,
        {
          networkId: "local",
          domainId: 1,
          candidates: ids.map((x) => x.nodeId),
          heartbeatTimeoutMs: 100,
        },
        (id) => keys[id],
      ).ok,
      true,
    );
  });
});

describe("UEP-34.4 quorum lab still works", () => {
  it("failoverWithQuorum with voter locks", () => {
    const lab = bootFailoverLab({ n: 4, mode: "LAB-QUORUM-FAILOVER" });
    lab.commitAsLeader({
      newStateRoot: "R1",
      transitionId: "t1",
      nullifier: "n1",
    });
    const fo = lab.failoverWithQuorum();
    assert.equal(fo.ok, true, fo.error);
  });
});
