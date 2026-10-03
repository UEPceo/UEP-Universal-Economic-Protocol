/**
 * UEP-37.5 — Process/TCP with Poseidon SMT stateRoot
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProcessCluster } from "./uep35-process-cluster.ts";
import { findUepZkBinary } from "./zk-bridge.ts";

describe("UEP-37.5 Process/TCP Poseidon SMT", () => {
  it("uep-zk available", () => {
    assert.ok(findUepZkBinary());
  });

  it("4 processes poseidon-zk: propose → same Poseidon stateRoot", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4, { leafMode: "poseidon-zk", smtDepth: 8 });
      for (let i = 0; i < 25; i++) {
        for (const n of cluster.nodes) {
          (n as { child: { stdin: { write: (s: string) => void } } }).child.stdin.write(
            JSON.stringify({ cmd: "status" }) + "\n",
          );
        }
        await new Promise((r) => setTimeout(r, 100));
        if (cluster.statusRoots().filter(Boolean).length === 4) break;
      }
      const genesis = cluster.statusRoots();
      assert.equal(new Set(genesis.filter(Boolean)).size, 1);
      assert.equal(genesis[0]!.length, 64);

      // Official digest-only aggregate path (one batch); plain single-batch
      // proposals are not accepted by peers since the digest-binding rule.
      await cluster.proposeAggregate("mn-0", [
        [{ id: "p-1", from: "s0", to: "r0", amount: "5" }],
      ]);
      const ok = await cluster.waitRootChange(genesis[0]!, 120_000);
      assert.equal(ok, true);
      assert.equal(new Set(cluster.statusRoots()).size, 1);
    } finally {
      await cluster.stop();
    }
  });

  it("aggregate across processes converges", async () => {
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
      const g0 = cluster.statusRoots()[0]!;
      await cluster.proposeAggregate("mn-0", [
        [{ id: "a1", from: "s0", to: "r0", amount: "2" }],
        [{ id: "a2", from: "s1", to: "r1", amount: "3" }],
      ]);
      const ok = await cluster.waitRootChange(g0, 150_000);
      assert.equal(ok, true);
      assert.equal(new Set(cluster.statusRoots()).size, 1);
    } finally {
      await cluster.stop();
    }
  });
});
