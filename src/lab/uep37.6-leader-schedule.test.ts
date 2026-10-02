/**
 * UEP-37.6 — Single leader per height + no concurrent pipeline
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scheduledLeader,
  isScheduledLeader,
  LEADER_SCHEDULE_VERSION,
} from "./uep37-leader-schedule.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { findUepZkBinary } from "./zk-bridge.ts";

describe("UEP-37.6 leader schedule", () => {
  it("version", () => {
    assert.match(LEADER_SCHEDULE_VERSION, /^37\./);
  });

  it("deterministic round-robin on sorted ids", () => {
    const ids = ["mn-2", "mn-0", "mn-1"];
    assert.equal(scheduledLeader(1, ids), "mn-0");
    assert.equal(scheduledLeader(2, ids), "mn-1");
    assert.equal(scheduledLeader(3, ids), "mn-2");
    assert.equal(scheduledLeader(4, ids), "mn-0");
    assert.equal(isScheduledLeader("mn-0", 1, ids), true);
    assert.equal(isScheduledLeader("mn-1", 1, ids), false);
  });

  it("non-leader propose returns null", () => {
    const cluster = new MultiNodeCluster(4, 3760, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
    });
    assert.ok(findUepZkBinary());
    // height 1 leader is mn-0
    assert.equal(cluster.leaderForNextHeight(), "mn-0");
    assert.equal(
      cluster.proposeAggregateFrom("mn-1", [
        { txs: [{ id: "x", from: "s0", to: "r0", amount: 1n }] },
      ]),
      null,
    );
    assert.ok(
      cluster.proposeAggregateFrom("mn-0", [
        { txs: [{ id: "y", from: "s0", to: "r0", amount: 1n }] },
      ]),
    );
  });

  it("concurrent dual propose: only height-1 leader succeeds; roots converge", () => {
    assert.ok(findUepZkBinary());
    const cluster = new MultiNodeCluster(4, 3761, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
    });
    const p0 = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "c1", from: "s0", to: "r0", amount: 1n }] },
    ]);
    const p1 = cluster.proposeAggregateFrom("mn-1", [
      { txs: [{ id: "c2", from: "s1", to: "r1", amount: 1n }] },
    ]);
    // mn-0 is leader for h1 → ok; mn-1 blocked (pipeline / not yet synced)
    assert.ok(p0);
    assert.equal(p1, null);

    for (let t = 0; t < 150; t++) {
      cluster.tick(20, 5);
      if (
        cluster.allHonestSameStateRoot() &&
        cluster.nodes.every((n) => n.economic.sequence >= 1)
      )
        break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
    assert.ok(cluster.nodes.every((n) => n.economic.sequence === 1));

    // After sync, mn-1 is leader for height 2
    assert.equal(cluster.leaderForNextHeight(), "mn-1");
    assert.ok(
      cluster.proposeAggregateFrom("mn-1", [
        { txs: [{ id: "c2b", from: "s1", to: "r1", amount: 1n }] },
      ]),
    );
    for (let t = 0; t < 150; t++) {
      cluster.tick(20, 5);
      if (
        cluster.allHonestSameStateRoot() &&
        cluster.nodes.every((n) => n.economic.sequence >= 2)
      )
        break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
    assert.equal(cluster.node("mn-0").economic.sequence, 2);
  });

  it("rotating leaders sequential still works", () => {
    const cluster = new MultiNodeCluster(4, 3762, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
    });
    for (let i = 0; i < 4; i++) {
      const leader = cluster.leaderForNextHeight();
      assert.ok(
        cluster.proposeAggregateFrom(leader, [
          { txs: [{ id: `r-${i}`, from: "s0", to: "r0", amount: 1n }] },
        ]),
      );
      for (let t = 0; t < 120; t++) {
        cluster.tick(20, 5);
        if (
          cluster.allHonestSameStateRoot() &&
          cluster.nodes.every((n) => n.economic.sequence >= i + 1)
        )
          break;
      }
      assert.equal(cluster.allHonestSameStateRoot(), true);
    }
  });
});
