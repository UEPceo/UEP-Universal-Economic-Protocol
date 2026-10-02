import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProcessCluster } from "./uep35-process-cluster.ts";
import { generateBootstrap } from "./uep35-process-node.ts";

describe("UEP-35.9 process-per-node (4 machines LAB)", () => {
  it("bootstrap generates 4 distinct node identities", () => {
    const b = generateBootstrap(4);
    assert.equal(b.nodes.length, 4);
    const ids = new Set(b.nodes.map((n) => n.id));
    assert.equal(ids.size, 4);
    assert.ok(b.nodes.every((n) => n.privateKeyHex && n.publicKeyHex));
  });

  it("4 OS processes: propose → finality → same stateRoot", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      assert.equal(cluster.nodes.length, 4);
      assert.ok(cluster.nodes.every((n) => n.port && n.port > 0));

      await cluster.propose("mn-0", [
        { id: "p9-0", from: "s0", to: "r0", amount: "1" },
        { id: "p9-1", from: "s1", to: "r1", amount: "1" },
      ]);

      const ok = await cluster.waitFinalized(12000);
      assert.equal(ok, true, "expected all processes finalized with same root");
      const roots = cluster.statusRoots();
      assert.equal(new Set(roots).size, 1);
      assert.ok(roots[0]!.length > 16);
    } finally {
      await cluster.stop();
    }
  });
});
