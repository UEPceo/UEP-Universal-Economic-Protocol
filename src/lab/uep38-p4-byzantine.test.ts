import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findBundledUepZk } from "./uep-zk-runner.ts";
import { P4QuorumLab } from "./uep38-p4-quorum.ts";

describe("UEP-38.12 Byzantine height lock", () => {
  it("binary present", () => {
    assert.ok(findBundledUepZk());
  });

  // INTEGRATION CONFLICT (C-3: this test proves a spend below 1000 units; the public core charges a minimum fee of 1 unit since v0.4.4, but the UEP-26 circuit enforces floor(amount/1000) with no minimum, so the proof cannot be built). Pending a maintainer decision; see docs/LABS.md.
  it.skip("honest replica will not vote two proposals at the same height", () => {
    const lab = new P4QuorumLab(4);
    const a = lab.buildProposal(1000n, 1);
    const b = lab.buildProposal(500n, 1);
    assert.notEqual(a.payloadDigest, b.payloadDigest);
    const voter = lab.replicas[1]!;
    assert.ok(lab.vote(a, voter));
    assert.equal(lab.vote(b, voter), null);
    assert.equal(voter.lastError, "HEIGHT_VOTE_LOCK_CONFLICT");
    assert.equal(
      lab.replicas[0]!.state.stateRoot(),
      lab.replicas[1]!.state.stateRoot(),
    );
  });

  // INTEGRATION CONFLICT (C-3: this test proves a spend below 1000 units; the public core charges a minimum fee of 1 unit since v0.4.4, but the UEP-26 circuit enforces floor(amount/1000) with no minimum, so the proof cannot be built). Pending a maintainer decision; see docs/LABS.md.
  it.skip("late replica catch-up from certified commit", () => {
    const lab = new P4QuorumLab(4);
    const env = lab.buildProposal(1000n, 1);
    const online = lab.replicas.slice(0, 3);
    const late = lab.replicas[3]!;
    const votes = online.map((r) => lab.vote(env, r)).filter((v) => v !== null);
    assert.ok(votes.length >= 3);
    const c = lab.commit(env, votes, online);
    assert.equal(c.ok, true, c.reason);
    const liveRoot = online[0]!.state.stateRoot();
    assert.notEqual(late.state.stateRoot(), liveRoot);
    const up = lab.catchUp(late, env, votes);
    assert.equal(up.ok, true, up.reason);
    assert.equal(late.state.stateRoot(), liveRoot);
    assert.equal(lab.vote(lab.buildProposal(500n, 1), late), null);
    assert.equal(late.lastError, "HEIGHT_VOTE_LOCK_CONFLICT");
  });

  it("same digest can be retried; no conflict", () => {
    const lab = new P4QuorumLab(4);
    const a = lab.buildProposal(1000n, 1);
    const voter = lab.replicas[2]!;
    assert.ok(lab.vote(a, voter));
    // lock confirms same digest
    const again = voter.heightLock.tryLock(a.epoch, a.height, a.payloadDigest);
    assert.equal(again.ok, true);
  });
});
