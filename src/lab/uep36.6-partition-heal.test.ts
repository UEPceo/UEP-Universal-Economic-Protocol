import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { ProcessCluster } from "./uep35-process-cluster.ts";

describe("UEP-36.6 partition/heal with DigestAggregate", () => {
  // ---- in-process multi-node ----
  it("in-process 3|1: majority finalizes aggregate; minority stays behind", () => {
    const cluster = new MultiNodeCluster(4, 3660);
    cluster.partition(["mn-0", "mn-1", "mn-2"], ["mn-3"]);

    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "a", from: "s0", to: "r0", amount: 5n }] },
      { txs: [{ id: "b", from: "s1", to: "r1", amount: 3n }] },
    ]);
    assert.ok(prop);

    for (let i = 0; i < 80; i++) cluster.tick(20, 5);

    const majority = cluster.nodes.filter((n) => n.id !== "mn-3" && !n.byzantine);
    const minority = cluster.node("mn-3");
    assert.ok(
      majority.every((n) => n.economic.sequence >= 1),
      "majority must advance",
    );
    assert.equal(
      majority[0]!.economic.stateRoot(),
      prop!.stateRoot,
    );
    assert.equal(
      minority.economic.sequence,
      0,
      "isolated node must not apply without messages",
    );
  });

  it("in-process: heal + resync → all honest same stateRoot", () => {
    const cluster = new MultiNodeCluster(4, 3661);
    cluster.partition(["mn-0", "mn-1", "mn-2"], ["mn-3"]);

    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "h1", from: "s0", to: "r0", amount: 2n }] },
      { txs: [{ id: "h2", from: "s1", to: "r1", amount: 2n }] },
    ]);
    assert.ok(prop);
    for (let i = 0; i < 60; i++) cluster.tick(20, 5);

    assert.equal(cluster.node("mn-3").economic.sequence, 0);

    cluster.heal();
    cluster.resyncAfterHeal();
    for (let i = 0; i < 100; i++) cluster.tick(20, 5);

    const honest = cluster.nodes.filter((n) => !n.byzantine);
    const roots = new Set(honest.map((n) => n.economic.stateRoot()));
    assert.equal(roots.size, 1, "after heal+resync all honest share stateRoot");
    assert.equal(honest[0]!.economic.stateRoot(), prop!.stateRoot);
    assert.ok(honest.every((n) => n.economic.sequence >= 1));
  });

  it("in-process 2|2: neither side reaches BFT quorum alone", () => {
    // n=4 quorum=3; 2|2 cannot form cert
    const cluster = new MultiNodeCluster(4, 3662);
    cluster.partition(["mn-0", "mn-1"], ["mn-2", "mn-3"]);
    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "q", from: "s0", to: "r0", amount: 1n }] },
    ]);
    assert.ok(prop);
    for (let i = 0; i < 50; i++) cluster.tick(20, 5);
    // No node should have finalized (insufficient votes cross partition)
    const advanced = cluster.nodes.filter((n) => n.economic.sequence >= 1);
    assert.equal(
      advanced.length,
      0,
      "2|2 partition must block BFT-CLASSIC finality",
    );
  });

  // ---- process / TCP ----
  it("process 3|1 aggregate: majority finalizes; mn-3 behind", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      await cluster.partition(["mn-0", "mn-1", "mn-2"], ["mn-3"]);
      await cluster.proposeAggregate("mn-0", [
        [
          { id: "p1", from: "s0", to: "r0", amount: "4" },
          { id: "p2", from: "s1", to: "r1", amount: "2" },
        ],
        [{ id: "p3", from: "s2", to: "r2", amount: "1" }],
      ]);

      let majorityOk = false;
      for (let i = 0; i < 100; i++) {
        const st = await cluster.pollStatus();
        const maj = st.filter((s) => s.nodeId !== "mn-3");
        const min = st.find((s) => s.nodeId === "mn-3")!;
        if (maj.every((s) => s.finalized.length >= 1)) {
          majorityOk = true;
          assert.equal(min.finalized.length, 0);
          assert.equal(new Set(maj.map((s) => s.stateRoot)).size, 1);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(majorityOk, true);
    } finally {
      await cluster.stop();
    }
  });

  it("process: partition → aggregate → heal → all 4 same stateRoot", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      await cluster.partition(["mn-0", "mn-1", "mn-2"], ["mn-3"]);
      await cluster.proposeAggregate("mn-0", [
        [{ id: "x1", from: "s0", to: "r0", amount: "3" }],
        [{ id: "x2", from: "s1", to: "r1", amount: "3" }],
      ]);

      for (let i = 0; i < 80; i++) {
        const st = await cluster.pollStatus();
        if (st.filter((s) => s.nodeId !== "mn-3").every((s) => s.finalized.length >= 1))
          break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await cluster.heal();

      let converged = false;
      for (let i = 0; i < 120; i++) {
        const st = await cluster.pollStatus();
        if (
          st.every((s) => s.finalized.length >= 1) &&
          new Set(st.map((s) => s.stateRoot)).size === 1
        ) {
          converged = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(converged, true, "after heal+resync all processes share stateRoot");
    } finally {
      await cluster.stop();
    }
  });
});
