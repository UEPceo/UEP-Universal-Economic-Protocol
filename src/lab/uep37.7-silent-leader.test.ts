/**
 * UEP-37.7 — Silent leader timeout → view change → backup leader proposes
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scheduledLeader,
  LEADER_SCHEDULE_VERSION,
} from "./uep37-leader-schedule.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { findUepZkBinary } from "./zk-bridge.ts";

describe("UEP-37.7 silent leader timeout", () => {
  it("schedule version 37.7 and view rotates leader", () => {
    assert.equal(LEADER_SCHEDULE_VERSION, "37.7");
    const ids = ["mn-0", "mn-1", "mn-2", "mn-3"];
    assert.equal(scheduledLeader(1, ids, 0), "mn-0");
    assert.equal(scheduledLeader(1, ids, 1), "mn-1");
    assert.equal(scheduledLeader(1, ids, 2), "mn-2");
  });

  it("advanceView rotates leader without advancing height", () => {
    const cluster = new MultiNodeCluster(4, 3770);
    assert.equal(cluster.nextProposeHeight(), 1);
    assert.equal(cluster.leaderForNextHeight(), "mn-0");
    const rec = cluster.advanceView("MANUAL");
    assert.equal(rec.fromView, 0);
    assert.equal(rec.toView, 1);
    assert.equal(rec.previousLeader, "mn-0");
    assert.equal(rec.newLeader, "mn-1");
    assert.equal(cluster.nextProposeHeight(), 1);
    assert.equal(cluster.leaderForNextHeight(), "mn-1");
  });

  it("silent timeout auto view-change then backup leader can propose", () => {
    assert.ok(findUepZkBinary());
    const cluster = new MultiNodeCluster(4, 3771, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
    });
    cluster.leaderTimeoutTicks = 40; // tick() steps budget
    assert.equal(cluster.leaderForNextHeight(), "mn-0");

    // mn-0 is silent: only tick until timeout
    for (let i = 0; i < 5; i++) {
      cluster.tick(20, 10); // 50 steps total > 40
    }
    assert.ok(cluster.viewChanges.length >= 1);
    assert.equal(cluster.viewChanges[0]!.reason, "SILENT_LEADER_TIMEOUT");
    assert.equal(cluster.leaderForNextHeight(), "mn-1");

    // backup leader proposes
    const prop = cluster.proposeAggregateFrom("mn-1", [
      { txs: [{ id: "backup-1", from: "s0", to: "r0", amount: 1n }] },
    ]);
    assert.ok(prop, "backup leader should propose after view change");
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
    // view reset after progress
    assert.equal(cluster.heightView, 0);
  });

  it("original leader blocked after view change for same height", () => {
    assert.ok(findUepZkBinary());
    const cluster = new MultiNodeCluster(4, 3772, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
    });
    cluster.advanceView("SILENT_LEADER_TIMEOUT");
    assert.equal(cluster.leaderForNextHeight(), "mn-1");
    assert.equal(
      cluster.proposeAggregateFrom("mn-0", [
        { txs: [{ id: "late", from: "s0", to: "r0", amount: 1n }] },
      ]),
      null,
    );
    assert.ok(
      cluster.proposeAggregateFrom("mn-1", [
        { txs: [{ id: "ok", from: "s0", to: "r0", amount: 1n }] },
      ]),
    );
  });

  it("multiple silent timeouts rotate through leaders", () => {
    const cluster = new MultiNodeCluster(4, 3773);
    cluster.leaderTimeoutTicks = 10;
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) cluster.tick(10, 5);
      seen.add(cluster.leaderForNextHeight());
    }
    assert.ok(seen.size >= 3, `expected multiple leaders, got ${[...seen]}`);
  });
});
