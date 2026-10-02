/**
 * UEP-36.9 — Soft restart + durable vote-lock (LAB)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import {
  snapshotNodeConsensus,
  softRestartNode,
  voteLockBlocks,
} from "./uep36-node-snapshot.ts";
import { HeightVoteLock } from "./uep36-aggregate-semantics.ts";

function waitSeq(cluster: MultiNodeCluster, minSeq: number, ticks = 100): boolean {
  for (let i = 0; i < ticks; i++) {
    cluster.tick(20, 5);
    const honest = cluster.nodes.filter((n) => !n.byzantine);
    if (
      honest.every((n) => n.economic.sequence >= minSeq) &&
      cluster.allHonestSameStateRoot()
    ) {
      return true;
    }
  }
  return false;
}

describe("UEP-36.9 node soft-restart + vote-lock durability", () => {
  it("snapshot captures locks and economic tip", () => {
    const cluster = new MultiNodeCluster(4, 3690);
    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "rs-1", from: "s0", to: "r0", amount: 2n }] },
    ]);
    assert.ok(prop);
    assert.equal(waitSeq(cluster, 1), true);
    const snap = snapshotNodeConsensus(cluster.node("mn-1"));
    assert.equal(snap.version, "36.9");
    assert.equal(snap.sequence, 1);
    assert.ok(Object.keys(snap.voteLocks).length >= 1);
    assert.ok(snap.stateRoot.length > 0);
  });

  it("soft restart preserves vote lock → conflict still blocked", () => {
    const cluster = new MultiNodeCluster(4, 3691);
    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "rs-2", from: "s0", to: "r0", amount: 1n }] },
      { txs: [{ id: "rs-3", from: "s1", to: "r1", amount: 1n }] },
    ]);
    assert.ok(prop);
    assert.equal(waitSeq(cluster, 1), true);

    const n = cluster.node("mn-2");
    const locked = n.voteLock.get(0, 1);
    assert.ok(locked);

    const snap = cluster.softRestart("mn-2");
    assert.equal(n.voteLock.get(0, 1), locked);
    assert.equal(n.seenMsgIds.size, 0);
    assert.equal(n.economic.sequence, snap.sequence);
    assert.equal(n.economic.stateRoot(), snap.stateRoot);

    assert.equal(voteLockBlocks(n, 0, 1, "EVIL-DIGEST-" + "00".repeat(24)), true);
    // same digest still ok
    assert.equal(n.voteLock.tryLock(0, 1, locked!).ok, true);
  });

  it("after soft restart of minority, next height still converges", () => {
    const cluster = new MultiNodeCluster(4, 3692);
    const p1 = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "rs-4", from: "s0", to: "r0", amount: 1n }] },
    ]);
    assert.ok(p1);
    assert.equal(waitSeq(cluster, 1), true);

    cluster.softRestart("mn-3");
    cluster.softRestart("mn-2");

    const p2 = cluster.proposeAggregateFrom("mn-1", [
      { txs: [{ id: "rs-5", from: "s1", to: "r1", amount: 2n }] },
    ]);
    assert.ok(p2);
    assert.equal(waitSeq(cluster, 2), true);
    assert.equal(cluster.allHonestSameStateRoot(), true);

    const honest = cluster.nodes.filter((n) => !n.byzantine);
    assert.ok(honest.every((n) => n.voteLock.get(0, 1)));
    assert.ok(honest.every((n) => n.voteLock.get(0, 2)));
  });

  it("partition → finalize → softRestart isolated → heal → catch-up + next leader", () => {
    const cluster = new MultiNodeCluster(4, 3693);
    cluster.partition(["mn-0", "mn-1", "mn-2"], ["mn-3"]);
    const p1 = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "rs-6", from: "s0", to: "r0", amount: 1n }] },
      { txs: [{ id: "rs-7", from: "s1", to: "r1", amount: 1n }] },
    ]);
    assert.ok(p1);
    for (let i = 0; i < 80; i++) cluster.tick(20, 5);
    assert.ok(cluster.nodes.filter((n) => n.id !== "mn-3").every((n) => n.economic.sequence >= 1));

    // Isolated node "restarts" while still partitioned (empty locks expected)
    cluster.softRestart("mn-3");
    assert.equal(cluster.node("mn-3").economic.sequence, 0);

    cluster.heal();
    cluster.resyncAfterHeal();
    assert.equal(waitSeq(cluster, 1, 120), true);

    // Height 1 lock should exist after catch-up votes... may not re-vote if only cert path
    // Economic convergence is the hard requirement
    const p2 = cluster.proposeAggregateFrom("mn-1", [
      { txs: [{ id: "rs-8", from: "s2", to: "r2", amount: 1n }] },
    ]);
    assert.ok(p2);
    assert.equal(waitSeq(cluster, 2, 100), true);
    assert.equal(cluster.allHonestSameStateRoot(), true);
  });

  it("HeightVoteLock restore is deterministic", () => {
    const a = new HeightVoteLock();
    a.tryLock(0, 1, "aaa");
    a.tryLock(0, 2, "bbb");
    const snap = a.snapshot();
    const b = new HeightVoteLock();
    b.restore(snap);
    assert.deepEqual(b.snapshot(), snap);
    assert.equal(b.tryLock(0, 1, "ccc").ok, false);
  });
});
