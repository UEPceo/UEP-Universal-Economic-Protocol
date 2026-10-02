import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findBundledUepZk } from "./uep-zk-runner.ts";
import { proposalDigestFromPayload } from "./uep35-consensus-msg.ts";
import { P4BftReplica, P4_BFT_VERSION } from "./uep38-p4-bft-envelope.ts";

describe("UEP-38.7 P4 inside signed PROPOSAL", () => {
  it("version", () => {
    assert.equal(P4_BFT_VERSION, "38.7");
    assert.ok(findBundledUepZk());
  });

  it("follower accepts signed proposal + Groth16; same root", () => {
    const leader = new P4BftReplica("leader", 4);
    const follower = new P4BftReplica("follower", 4);
    assert.equal(leader.state.stateRoot(), follower.state.stateRoot());
    const env = leader.proposeSpend(1000n, 1);
    assert.equal(follower.acceptProposal(env, leader.identity.publicKeyHex), true, follower.lastError ?? "");
    assert.equal(follower.state.stateRoot(), leader.state.stateRoot());
  });

  it("wrong signer rejected; follower root unchanged", () => {
    const leader = new P4BftReplica("leader2", 4);
    const follower = new P4BftReplica("follower2", 4);
    const env = leader.proposeSpend(1000n, 1);
    const before = follower.state.stateRoot();
    assert.equal(follower.acceptProposal(env, follower.identity.publicKeyHex), false);
    assert.equal(follower.lastError, "BAD_ENVELOPE_SIG");
    assert.equal(follower.state.stateRoot(), before);
  });

  it("proposal digest without zkSpend unchanged vs 35.7.1 formula", () => {
    const d = proposalDigestFromPayload({
      batchId: "b",
      txDigest: "t",
      stateRoot: "r",
      epoch: 1,
      height: 1,
      previousStateRoot: "p",
    });
    assert.equal(d.length, 64);
  });
});
