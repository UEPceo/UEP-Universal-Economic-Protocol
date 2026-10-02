import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findUepZkBinary } from "./zk-bridge.ts";
import { runUep33ZkPaymentCluster } from "./uep33-zk-pipeline.ts";
import { bootUep33Cluster, rootsEqual } from "./uep33-cluster.ts";
import { sleep } from "./node-auth-transport.ts";

describe("UEP-33.1 ZK on 3-node cluster", () => {
  it("Payment → Groth16 → A/B/C all verify → same root", async () => {
    assert.ok(findUepZkBinary(), "uep-zk binary REQUIRED — CI must FAIL if missing (no SKIP)");
    const r = await runUep33ZkPaymentCluster({ amount: 1800n, profile: "DEV-ZK" });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.transitionIds.length >= 1);
    assert.equal(r.roots.seq, r.roots.r1);
    assert.equal(r.roots.seq, r.roots.r2);
    assert.equal(r.sequences.seq, r.sequences.r1);
    assert.equal(r.sequences.seq, r.sequences.r2);
    assert.ok(r.roots.seq !== "GENESIS");
  });

  it("multi-host bind 0.0.0.0: cluster converges (LAN-ready path)", async () => {
    const c = await bootUep33Cluster({
      requireZkVerify: false,
      listenHost: "0.0.0.0",
    });
    try {
      for (let i = 1; i <= 3; i++) {
        const r = c.seq.commitAndBroadcast({
          previousStateRoot: c.seq.lab.stateRoot,
          newStateRoot: `LAN_${i}`,
          transitionId: `lan-${i}`,
          nullifier: `nlan-${i}`,
        });
        assert.equal(r.ok, true, (r as { error?: string }).error);
        await sleep(40);
      }
      assert.ok(rootsEqual(c.seq, c.r1, c.r2));
      assert.equal(c.seq.lab.sequence, 3);
    } finally {
      await c.stop();
    }
  });

  it("ZK + 0.0.0.0 bind: payment settles on all three", async () => {
    assert.ok(findUepZkBinary(), "uep-zk binary REQUIRED — CI must FAIL if missing (no SKIP)");
    const r = await runUep33ZkPaymentCluster({
      amount: 1200n,
      profile: "DEV-ZK",
      listenHost: "0.0.0.0",
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.roots.seq, r.roots.r1);
    assert.equal(r.roots.r1, r.roots.r2);
  });
});
