import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createNodeIdentity,
  LabNode,
  signEnvelope,
  NODE_PROTOCOL_VERSION,
} from "./node-protocol.ts";
import { NetworkLabNode, sleep } from "./node-transport.ts";

function makeCluster() {
  const seqId = createNodeIdentity("seq");
  const seq = new NetworkLabNode({
    lab: new LabNode(seqId, "local", 1, seqId.publicKeyHex, seqId.nodeId),
    isSequencer: true,
  });
  const r2 = new NetworkLabNode({
    lab: new LabNode(
      createNodeIdentity("r2"),
      "local",
      1,
      seqId.publicKeyHex,
      seqId.nodeId,
    ),
    isSequencer: false,
  });
  const r3 = new NetworkLabNode({
    lab: new LabNode(
      createNodeIdentity("r3"),
      "local",
      1,
      seqId.publicKeyHex,
      seqId.nodeId,
    ),
    isSequencer: false,
  });
  return { seq, r2, r3, seqId };
}

async function bootStar() {
  const c = makeCluster();
  const seqPort = await c.seq.start();
  await c.r2.start();
  await c.r3.start();
  await c.r2.connectToSequencer(seqPort);
  await c.r3.connectToSequencer(seqPort);
  await sleep(20);
  return { ...c, seqPort };
}

async function stopAll(...nodes: NetworkLabNode[]) {
  await Promise.all(nodes.map((n) => n.stop()));
}

describe("UEP-32 TCP + Ed25519", () => {
  it("3 nodes converge via sequencer broadcast", async () => {
    const { seq, r2, r3 } = await bootStar();
    try {
      for (const [i, root] of ["B", "C", "D"].entries()) {
        const r = seq.commitAndBroadcast({
          previousStateRoot: seq.lab.stateRoot,
          newStateRoot: `ROOT_${root}`,
          transitionId: `t${i + 1}`,
          nullifier: `n${i + 1}`,
          newNullifierRoot: `NF_${root}`,
        });
        assert.equal(r.ok, true, (r as { error?: string }).error);
        await sleep(30);
      }
      assert.equal(seq.lab.stateRoot, "ROOT_D");
      assert.equal(r2.lab.stateRoot, "ROOT_D");
      assert.equal(r3.lab.stateRoot, "ROOT_D");
    } finally {
      await stopAll(seq, r2, r3);
    }
  });

  it("catch-up after joining late", async () => {
    const seqId = createNodeIdentity("seq");
    const seq = new NetworkLabNode({
      lab: new LabNode(seqId, "local", 1, seqId.publicKeyHex, seqId.nodeId),
      isSequencer: true,
    });
    const seqPort = await seq.start();
    for (let i = 1; i <= 4; i++) {
      seq.commitAndBroadcast({
        previousStateRoot: seq.lab.stateRoot,
        newStateRoot: `R${i}`,
        transitionId: `tx${i}`,
        nullifier: `nf${i}`,
      });
    }
    const late = new NetworkLabNode({
      lab: new LabNode(
        createNodeIdentity("late"),
        "local",
        1,
        seqId.publicKeyHex,
        seqId.nodeId,
      ),
      isSequencer: false,
    });
    await late.start();
    await late.connectToSequencer(seqPort);
    await sleep(15);
    late.requestCatchUp();
    await sleep(50);
    try {
      assert.equal(late.lab.stateRoot, seq.lab.stateRoot);
      assert.equal(late.lab.sequence, 4);
    } finally {
      await stopAll(seq, late);
    }
  });

  it("N1 duplicate / N2 bad sig / N3 stale", async () => {
    const { seq, r2, seqId } = await bootStar();
    try {
      const r = seq.commitAndBroadcast({
        previousStateRoot: "GENESIS",
        newStateRoot: "ROOT_B",
        transitionId: "dup1",
        nullifier: "n1",
      });
      assert.equal(r.ok, true);
      await sleep(30);
      if (r.ok) {
        seq.transport.broadcast({ type: "envelope", envelope: r.envelope });
        await sleep(20);
      }
      assert.equal(r2.lab.sequence, 1);

      const bad = {
        ...signEnvelope(seqId, {
          protocolVersion: NODE_PROTOCOL_VERSION,
          networkId: "local",
          domainId: 1,
          sequence: 2,
          previousStateRoot: "ROOT_B",
          newStateRoot: "HACK",
          transitionId: "evil",
          nullifier: "nx",
          ts: Date.now(),
        }),
        signature: "aa".repeat(64),
      };
      seq.transport.broadcast({ type: "envelope", envelope: bad });
      await sleep(20);
      assert.equal(r2.lab.stateRoot, "ROOT_B");

      const stale = signEnvelope(seqId, {
        protocolVersion: NODE_PROTOCOL_VERSION,
        networkId: "local",
        domainId: 1,
        sequence: 2,
        previousStateRoot: "GENESIS",
        newStateRoot: "ROOT_X",
        transitionId: "t2",
        nullifier: "n2",
        ts: Date.now(),
      });
      seq.transport.broadcast({ type: "envelope", envelope: stale });
      await sleep(20);
      assert.equal(r2.lab.sequence, 1);
    } finally {
      await stopAll(seq, r2);
    }
  });
});
