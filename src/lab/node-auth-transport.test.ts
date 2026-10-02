import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createNodeIdentity,
  NodeRegistry,
  registryFromIdentity,
} from "./node-identity.ts";
import { LabNode } from "./node-protocol.ts";
import { AuthNetworkNode, sleep } from "./node-auth-transport.ts";

function setupPair() {
  const seqId = createNodeIdentity("seq");
  const r2Id = createNodeIdentity("r2");
  const reg = new NodeRegistry();
  reg.register(
    registryFromIdentity(seqId, {
      networkId: "local",
      domainId: 1,
      role: "sequencer",
    }),
  );
  reg.register(
    registryFromIdentity(r2Id, {
      networkId: "local",
      domainId: 1,
      role: "replica",
    }),
  );
  const seq = new AuthNetworkNode({
    lab: new LabNode(seqId, "local", 1, seqId.publicKeyHex, seqId.nodeId),
    registry: reg,
    isSequencer: true,
    role: "sequencer",
  });
  const r2 = new AuthNetworkNode({
    lab: new LabNode(r2Id, "local", 1, seqId.publicKeyHex, seqId.nodeId),
    registry: reg,
    isSequencer: false,
    role: "replica",
  });
  return { seq, r2, seqId, r2Id, reg };
}

describe("UEP-32 handshake on TCP socket", () => {
  it("replica completes HELLO→AUTH before receiving envelopes", async () => {
    const { seq, r2 } = setupPair();
    try {
      const port = await seq.start();
      await r2.start();
      const peer = await r2.connectToSequencer("127.0.0.1", port);
      assert.equal(peer, "seq");
      assert.ok(seq.transport.authenticatedPeerCount() >= 1);
      assert.ok(r2.authenticatedPeers.includes("seq") || r2.transport.authenticatedPeerCount() >= 1);

      const r = seq.commitAndBroadcast({
        previousStateRoot: "GENESIS",
        newStateRoot: "ROOT_B",
        transitionId: "t1",
        nullifier: "n1",
      });
      assert.equal(r.ok, true);
      await sleep(50);
      assert.equal(r2.lab.stateRoot, "ROOT_B");
      assert.equal(r2.lab.sequence, 1);
    } finally {
      await seq.stop();
      await r2.stop();
    }
  });

  it("unknown node cannot complete handshake / receive state", async () => {
    const seqId = createNodeIdentity("seq");
    const stranger = createNodeIdentity("stranger");
    const reg = new NodeRegistry();
    reg.register(
      registryFromIdentity(seqId, {
        networkId: "local",
        domainId: 1,
        role: "sequencer",
      }),
    );
    // stranger NOT registered
    const seq = new AuthNetworkNode({
      lab: new LabNode(seqId, "local", 1, seqId.publicKeyHex, seqId.nodeId),
      registry: reg,
      isSequencer: true,
      role: "sequencer",
    });
    const bad = new AuthNetworkNode({
      lab: new LabNode(stranger, "local", 1, seqId.publicKeyHex, seqId.nodeId),
      registry: reg,
      isSequencer: false,
      role: "replica",
    });
    try {
      const port = await seq.start();
      await bad.start();
      await assert.rejects(
        () => bad.connectToSequencer("127.0.0.1", port),
        /handshake|closed|timeout|reject/i,
      );
    } finally {
      await seq.stop();
      await bad.stop();
    }
  });

  it("listenHost 0.0.0.0 accepted (multi-host ready)", async () => {
    const { seq, r2 } = setupPair();
    // recreate seq with 0.0.0.0
    const seqId = createNodeIdentity("seq0");
    const r2Id = createNodeIdentity("r20");
    const reg = new NodeRegistry();
    reg.register(
      registryFromIdentity(seqId, {
        networkId: "local",
        domainId: 1,
        role: "sequencer",
      }),
    );
    reg.register(
      registryFromIdentity(r2Id, {
        networkId: "local",
        domainId: 1,
        role: "replica",
      }),
    );
    const s = new AuthNetworkNode({
      lab: new LabNode(seqId, "local", 1, seqId.publicKeyHex, seqId.nodeId),
      registry: reg,
      isSequencer: true,
      role: "sequencer",
      listenHost: "0.0.0.0",
    });
    const r = new AuthNetworkNode({
      lab: new LabNode(r2Id, "local", 1, seqId.publicKeyHex, seqId.nodeId),
      registry: reg,
      isSequencer: false,
      role: "replica",
    });
    try {
      const port = await s.start();
      await r.start();
      await r.connectToSequencer("127.0.0.1", port);
      s.commitAndBroadcast({
        previousStateRoot: "GENESIS",
        newStateRoot: "R1",
        transitionId: "x1",
        nullifier: "n",
      });
      await sleep(50);
      assert.equal(r.lab.stateRoot, "R1");
    } finally {
      await s.stop();
      await r.stop();
      await seq.stop();
      await r2.stop();
    }
  });
});
