/**
 * UEP-37.5 stress — sequential load, dual-leader sequential, insufficient, process mesh
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { ProcessCluster } from "./uep35-process-cluster.ts";
import { findUepZkBinary } from "./zk-bridge.ts";

describe("UEP-37.5 stress Poseidon network", () => {
  it("in-process: 10 sequential aggregates same root (poseidon D=8)", () => {
    assert.ok(findUepZkBinary());
    const cluster = new MultiNodeCluster(4, 3750, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
    });
    let prev = cluster.node("mn-0").economic.stateRoot();
    for (let i = 0; i < 10; i++) {
      const leader = `mn-${i % 4}`;
      const prop = cluster.proposeAggregateFrom(leader, [
        { txs: [{ id: `s-${i}`, from: "s0", to: "r0", amount: 1n }] },
      ]);
      assert.ok(prop, `propose failed at ${i}`);
      for (let t = 0; t < 120; t++) {
        cluster.tick(20, 5);
        if (
          cluster.allHonestSameStateRoot() &&
          cluster.nodes.every((n) => n.economic.sequence >= i + 1)
        )
          break;
      }
      assert.equal(cluster.allHonestSameStateRoot(), true, `round ${i}`);
      const root = cluster.node("mn-0").economic.stateRoot();
      assert.notEqual(root, prev, `root stagnant at ${i}`);
      prev = root;
    }
    assert.equal(cluster.node("mn-0").economic.sequence, 10);
  });

  it("in-process: rotating leaders sequential — no divergence", () => {
    const cluster = new MultiNodeCluster(4, 3751, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
    });
    for (let i = 0; i < 4; i++) {
      const leader = `mn-${i}`;
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
      assert.equal(cluster.allHonestSameStateRoot(), true, `leader ${leader}`);
    }
  });

  it("in-process: concurrent dual propose — only scheduled leader; roots converge (37.6)", () => {
    const cluster = new MultiNodeCluster(4, 3799, {
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
    assert.ok(p0);
    assert.equal(p1, null); // pipeline lock until height 1 applied everywhere
    for (let t = 0; t < 150; t++) {
      cluster.tick(20, 5);
      if (cluster.allHonestSameStateRoot() && cluster.nodes.every((n) => n.economic.sequence >= 1))
        break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
    assert.ok(cluster.nodes.every((n) => n.economic.sequence === 1));
  });

  it("in-process: insufficient funds returns null, no throw, roots stable", () => {
    const cluster = new MultiNodeCluster(4, 3752, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
      initialBalances: { s0: 5n, r0: 0n, s1: 100n, r1: 0n },
    });
    const before = cluster.node("mn-0").economic.stateRoot();
    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "bad", from: "s0", to: "r0", amount: 1000n }] },
    ]);
    assert.equal(prop, null);
    for (let t = 0; t < 20; t++) cluster.tick(20, 5);
    assert.equal(cluster.allHonestSameStateRoot(), true);
    assert.equal(cluster.node("mn-0").economic.stateRoot(), before);
  });

  it("process mesh: 3 sequential txs each change root, all match", async () => {
    assert.ok(findUepZkBinary());
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4, { leafMode: "poseidon-zk", smtDepth: 8 });
      for (let i = 0; i < 20; i++) {
        for (const n of cluster.nodes) {
          (n as { child: { stdin: { write: (s: string) => void } } }).child.stdin.write(
            JSON.stringify({ cmd: "status" }) + "\n",
          );
        }
        await new Promise((r) => setTimeout(r, 100));
        if (cluster.statusRoots().filter(Boolean).length === 4) break;
      }
      let last = cluster.statusRoots()[0]!;
      for (let i = 0; i < 3; i++) {
        await cluster.propose("mn-0", [
          { id: `st-${i}`, from: "s0", to: "r0", amount: "1" },
        ]);
        const changed = await cluster.waitRootChange(last, 120_000);
        assert.equal(changed, true, `tx ${i} no root change; roots=${cluster.statusRoots()}`);
        const roots = cluster.statusRoots();
        assert.equal(new Set(roots).size, 1);
        last = roots[0]!;
      }
    } finally {
      await cluster.stop();
    }
  });
});
