import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bootUep33Cluster,
  rootsEqual,
} from "./uep33-cluster.ts";
import { sleep } from "./node-auth-transport.ts";
import { signEnvelope, NODE_PROTOCOL_VERSION } from "./node-protocol.ts";
import fs from "node:fs";

describe("UEP-33 multi-machine lab (3 independent nodes)", () => {
  it("3 nodes converge after sequential commits", async () => {
    const c = await bootUep33Cluster({ requireZkVerify: false });
    try {
      for (let i = 1; i <= 5; i++) {
        const r = c.seq.commitAndBroadcast({
          previousStateRoot: c.seq.lab.stateRoot,
          newStateRoot: `ROOT_${i}`,
          transitionId: `tx-${i}`,
          nullifier: `nf-${i}`,
          newNullifierRoot: `NF_${i}`,
        });
        assert.equal(r.ok, true, (r as { error?: string }).error);
        await sleep(40);
      }
      assert.equal(c.seq.lab.sequence, 5);
      assert.equal(c.r1.lab.stateRoot, c.seq.lab.stateRoot);
      assert.equal(c.r2.lab.stateRoot, c.seq.lab.stateRoot);
      assert.ok(rootsEqual(c.seq, c.r1, c.r2));
      c.persist();
      assert.ok(fs.existsSync(`${c.dataDir}/node-a/lab-node-state.json`));
    } finally {
      await c.stop();
    }
  });

  it("replica disconnect → TXs → reconnect + catch-up → same root", async () => {
    const c = await bootUep33Cluster({ requireZkVerify: false });
    try {
      c.seq.commitAndBroadcast({
        previousStateRoot: "GENESIS",
        newStateRoot: "R1",
        transitionId: "t1",
        nullifier: "n1",
      });
      await sleep(40);

      // B goes offline
      await c.disconnectReplica(1);

      for (let i = 2; i <= 4; i++) {
        c.seq.commitAndBroadcast({
          previousStateRoot: c.seq.lab.stateRoot,
          newStateRoot: `R${i}`,
          transitionId: `t${i}`,
          nullifier: `n${i}`,
        });
        await sleep(30);
      }
      // r1 stuck at R1 if it applied t1; after disconnect it missed t2-t4
      assert.equal(c.seq.lab.sequence, 4);
      assert.ok(c.r1.lab.sequence < c.seq.lab.sequence);

      await c.reconnectReplica(1);
      assert.equal(c.r1.lab.stateRoot, c.seq.lab.stateRoot);
      assert.equal(c.r1.lab.sequence, c.seq.lab.sequence);
      assert.equal(c.r2.lab.stateRoot, c.seq.lab.stateRoot);
    } finally {
      await c.stop();
    }
  });

  it("tampered envelope rejected by both replicas", async () => {
    const c = await bootUep33Cluster({ requireZkVerify: false });
    try {
      const env = signEnvelope(c.seqId, {
        protocolVersion: NODE_PROTOCOL_VERSION,
        networkId: "local",
        domainId: 1,
        sequence: 1,
        previousStateRoot: "GENESIS",
        newStateRoot: "HACK",
        transitionId: "evil",
        nullifier: "nx",
        ts: Date.now(),
      });
      const bad = { ...env, signature: "00".repeat(64) };
      c.seq.transport.broadcastEnvelope(bad);
      await sleep(40);
      assert.equal(c.r1.lab.sequence, 0);
      assert.equal(c.r2.lab.sequence, 0);
      assert.equal(c.r1.lab.stateRoot, "GENESIS");
    } finally {
      await c.stop();
    }
  });

  it("persist + reload state from disk", async () => {
    const dataDir = `/tmp/uep33-persist-${Date.now()}`;
    const c1 = await bootUep33Cluster({
      requireZkVerify: false,
      dataDir,
    });
    try {
      c1.seq.commitAndBroadcast({
        previousStateRoot: "GENESIS",
        newStateRoot: "PERSISTED_ROOT",
        transitionId: "p1",
        nullifier: "np1",
      });
      await sleep(40);
      c1.persist();
      assert.equal(c1.seq.lab.stateRoot, "PERSISTED_ROOT");
    } finally {
      await c1.stop();
    }

    const c2 = await bootUep33Cluster({
      requireZkVerify: false,
      dataDir,
    });
    try {
      assert.equal(c2.seq.lab.stateRoot, "PERSISTED_ROOT");
      assert.equal(c2.seq.lab.sequence, 1);
    } finally {
      await c2.stop();
    }
  });
});
