import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createNodeIdentity,
  LabNode,
  signEnvelope,
  verifyEnvelope,
  NODE_PROTOCOL_VERSION,
} from "./node-protocol.ts";

describe("UEP-32 Ed25519 multi-node lab", () => {
  it("3 nodes converge with Ed25519 signed envelopes", () => {
    const seqId = createNodeIdentity("node-1");
    const sequencer = new LabNode(seqId, "local", 1, seqId.publicKeyHex, seqId.nodeId);
    const r2 = new LabNode(
      createNodeIdentity("node-2"),
      "local",
      1,
      seqId.publicKeyHex,
      seqId.nodeId,
    );
    const r3 = new LabNode(
      createNodeIdentity("node-3"),
      "local",
      1,
      seqId.publicKeyHex,
      seqId.nodeId,
    );

    for (const tx of [
      { tid: "t1", nf: "nf1", next: "ROOT_B" },
      { tid: "t2", nf: "nf2", next: "ROOT_C" },
      { tid: "t3", nf: "nf3", next: "ROOT_D" },
    ]) {
      const env = sequencer.propose({
        previousStateRoot: sequencer.stateRoot,
        newStateRoot: tx.next,
        transitionId: tx.tid,
        nullifier: tx.nf,
        newNullifierRoot: `NF_${tx.next}`,
      });
      assert.equal(sequencer.apply(env).ok, true);
      assert.equal(r2.apply(env).ok, true);
      assert.equal(r3.apply(env).ok, true);
    }

    assert.equal(sequencer.stateRoot, "ROOT_D");
    assert.equal(r2.stateRoot, sequencer.stateRoot);
    assert.equal(r3.stateRoot, sequencer.stateRoot);
    assert.equal(r2.sequence, 3);
  });

  it("replica catch-up after downtime", () => {
    const seqId = createNodeIdentity("node-1");
    const sequencer = new LabNode(seqId, "local", 1, seqId.publicKeyHex, seqId.nodeId);
    const late = new LabNode(
      createNodeIdentity("node-2"),
      "local",
      1,
      seqId.publicKeyHex,
      seqId.nodeId,
    );
    for (let i = 1; i <= 5; i++) {
      const env = sequencer.propose({
        previousStateRoot: sequencer.stateRoot,
        newStateRoot: `R${i}`,
        transitionId: `t${i}`,
        nullifier: `n${i}`,
      });
      sequencer.apply(env);
    }
    assert.equal(late.catchUp(sequencer.log), 5);
    assert.equal(late.stateRoot, sequencer.stateRoot);
  });

  it("rejects stale root, replay, and bad signature", () => {
    const seqId = createNodeIdentity("node-1");
    const sequencer = new LabNode(seqId, "local", 1, seqId.publicKeyHex, seqId.nodeId);
    const r2 = new LabNode(
      createNodeIdentity("node-2"),
      "local",
      1,
      seqId.publicKeyHex,
      seqId.nodeId,
    );
    const env = sequencer.propose({
      previousStateRoot: "GENESIS",
      newStateRoot: "ROOT_B",
      transitionId: "t1",
      nullifier: "n1",
    });
    assert.equal(sequencer.apply(env).ok, true);
    assert.equal(r2.apply(env).ok, true);
    assert.equal(r2.apply(env).error, "IDEMPOTENT_REPLAY");

    const stale = signEnvelope(seqId, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 2,
      previousStateRoot: "WRONG",
      newStateRoot: "X",
      transitionId: "t2",
      nullifier: "n2",
      ts: Date.now(),
    });
    assert.equal(r2.apply(stale).error, "STALE_ROOT");

    const good = signEnvelope(seqId, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 2,
      previousStateRoot: "ROOT_B",
      newStateRoot: "ROOT_C",
      transitionId: "t3",
      nullifier: "n3",
      ts: Date.now(),
    });
    const tampered = { ...good, newStateRoot: "HACKED" };
    assert.equal(verifyEnvelope(tampered, seqId.publicKeyHex, seqId.nodeId), false);
  });

  it("documents sequencer failure without failover", () => {
    const seqId = createNodeIdentity("seq");
    const n = new LabNode(seqId, "local", 1, seqId.publicKeyHex, seqId.nodeId);
    assert.equal(n.sequencerFailed, false);
    n.markSequencerFailed();
    assert.equal(n.sequencerFailed, true);
    // FAILOVER NOT IMPLEMENTED — flag only
  });
});
