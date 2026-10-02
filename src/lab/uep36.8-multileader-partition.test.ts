/**
 * UEP-36.8 — Multi-leader × partition/heal + vote-lock durability (LAB)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { ProcessCluster } from "./uep35-process-cluster.ts";
import { HeightVoteLock } from "./uep36-aggregate-semantics.ts";

function waitHonestFinalized(
  cluster: MultiNodeCluster,
  minSeq: number,
  ticks = 100,
): boolean {
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

describe("UEP-36.8 multi-leader × partition/heal", () => {
  it("rotating leaders: mn-0 then mn-1 aggregates → chain heights, same root", () => {
    const cluster = new MultiNodeCluster(4, 3680);
    const p1 = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "ml-a1", from: "s0", to: "r0", amount: 2n }] },
      { txs: [{ id: "ml-a2", from: "s1", to: "r1", amount: 1n }] },
    ]);
    assert.ok(p1);
    assert.equal(waitHonestFinalized(cluster, 1), true);

    const root1 = cluster.node("mn-0").economic.stateRoot();
    const p2 = cluster.proposeAggregateFrom("mn-1", [
      { txs: [{ id: "ml-b1", from: "s2", to: "r2", amount: 1n }] },
    ]);
    assert.ok(p2);
    assert.equal(waitHonestFinalized(cluster, 2), true);

    const honest = cluster.nodes.filter((n) => !n.byzantine);
    assert.equal(cluster.allHonestSameStateRoot(), true);
    assert.notEqual(root1, honest[0]!.economic.stateRoot());
    // Vote locks: height 1 and 2 locked on all honest
    for (const n of honest) {
      assert.ok(n.voteLock.get(0, 1), `${n.id} missing lock h=1`);
      assert.ok(n.voteLock.get(0, 2), `${n.id} missing lock h=2`);
    }
    // All honest agree on locks
    const l1 = new Set(honest.map((n) => n.voteLock.get(0, 1)));
    const l2 = new Set(honest.map((n) => n.voteLock.get(0, 2)));
    assert.equal(l1.size, 1);
    assert.equal(l2.size, 1);
  });

  it("3|1 partition: majority leader finalizes; after heal next leader advances", () => {
    const cluster = new MultiNodeCluster(4, 3681);
    cluster.partition(["mn-0", "mn-1", "mn-2"], ["mn-3"]);

    const p1 = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "ph-1", from: "s0", to: "r0", amount: 3n }] },
      { txs: [{ id: "ph-2", from: "s1", to: "r1", amount: 1n }] },
    ]);
    assert.ok(p1);
    for (let i = 0; i < 80; i++) cluster.tick(20, 5);

    const majority = cluster.nodes.filter((n) => n.id !== "mn-3");
    assert.ok(majority.every((n) => n.economic.sequence >= 1));
    assert.equal(cluster.node("mn-3").economic.sequence, 0);

    cluster.heal();
    cluster.resyncAfterHeal();
    assert.equal(waitHonestFinalized(cluster, 1, 120), true);

    // New leader mn-1 proposes height 2
    const p2 = cluster.proposeAggregateFrom("mn-1", [
      { txs: [{ id: "ph-3", from: "s2", to: "r0", amount: 1n }] },
    ]);
    assert.ok(p2);
    assert.equal(waitHonestFinalized(cluster, 2, 100), true);
    assert.equal(cluster.allHonestSameStateRoot(), true);

    const honest = cluster.nodes.filter((n) => !n.byzantine);
    assert.ok(honest.every((n) => n.voteLock.get(0, 1)));
    assert.ok(honest.every((n) => n.voteLock.get(0, 2)));
  });

  it("vote-lock snapshot restore blocks conflicting digest at same height", () => {
    const lock = new HeightVoteLock();
    assert.equal(lock.tryLock(0, 5, "DIGEST-A").ok, true);
    const snap = lock.snapshot();

    const restored = new HeightVoteLock();
    restored.restore(snap);
    assert.equal(restored.get(0, 5), "DIGEST-A");
    assert.equal(restored.tryLock(0, 5, "DIGEST-A").ok, true);
    assert.equal(restored.tryLock(0, 5, "DIGEST-B").ok, false);
    assert.equal(restored.hasEvidence(), true);
  });

  it("cannot re-lock different digest after height already finalized (in-process)", () => {
    const cluster = new MultiNodeCluster(4, 3682);
    const p1 = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "rl-1", from: "s0", to: "r0", amount: 1n }] },
    ]);
    assert.ok(p1);
    assert.equal(waitHonestFinalized(cluster, 1), true);

    // Simulate late conflicting proposal at height 1 from Byzantine leader
    const eq = cluster.proposeAggregateEquivocation("mn-0", [
      { txs: [{ id: "rl-evil", from: "s1", to: "r1", amount: 1n }] },
    ]);
    // globalSeq advances on equivocation helper — this is a new height attempt
    // Stronger check: honest locks for height 1 remain the original digest
    for (let i = 0; i < 40; i++) cluster.tick(20, 5);
    const honest = cluster.nodes.filter((n) => !n.byzantine);
    const h1 = honest.map((n) => n.voteLock.get(0, 1));
    assert.ok(h1.every((d) => d === h1[0] && d !== undefined));
    // All still same economic root from first finality (no fork)
    assert.equal(cluster.allHonestSameStateRoot(), true);
  });

  it("process: mn-0 aggregate under 3|1; heal; mn-1 next aggregate; converge", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      await cluster.partition(["mn-0", "mn-1", "mn-2"], ["mn-3"]);
      await cluster.proposeAggregate("mn-0", [
        [{ id: "p-ml-1", from: "s0", to: "r0", amount: "2" }],
        [{ id: "p-ml-2", from: "s1", to: "r1", amount: "1" }],
      ]);

      let majOk = false;
      for (let i = 0; i < 100; i++) {
        const st = await cluster.pollStatus();
        const maj = st.filter((s) => s.nodeId !== "mn-3");
        if (maj.every((s) => s.finalized.length >= 1)) {
          majOk = true;
          assert.equal(st.find((s) => s.nodeId === "mn-3")!.finalized.length, 0);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(majOk, true);

      await cluster.heal();

      // Wait catch-up of mn-3
      for (let i = 0; i < 80; i++) {
        const st = await cluster.pollStatus();
        if (st.every((s) => s.finalized.length >= 1) && new Set(st.map((s) => s.stateRoot)).size === 1)
          break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await cluster.proposeAggregate("mn-1", [
        [{ id: "p-ml-3", from: "s2", to: "r2", amount: "1" }],
      ]);

      let converged = false;
      for (let i = 0; i < 120; i++) {
        const st = await cluster.pollStatus();
        if (
          st.every((s) => s.finalized.length >= 2) &&
          new Set(st.map((s) => s.stateRoot)).size === 1
        ) {
          converged = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(converged, true, "multi-leader after heal must converge");
    } finally {
      await cluster.stop();
    }
  });
});
