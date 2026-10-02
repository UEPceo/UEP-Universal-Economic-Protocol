import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { P4ProcessCluster } from "./uep38-p4-process-cluster.ts";
import { P4_PROCESS_VERSION } from "./uep38-p4-process-node.ts";

describe("UEP-38.20 parallel disjoint spends", () => {
  it("version", () => {
    assert.equal(P4_PROCESS_VERSION, "38.35");
  });

  it("two spends proved together, four replicas same root", async () => {
    process.env.UEP_P4_CAROL = "1";
    const c = new P4ProcessCluster();
    try {
      await c.start(4, 32);
      const t0 = Date.now();
      await c.proposeBatch(1000n, 700n, 1, "p4-0");
      await c.waitHeight(1, 120000);
      const roots = await c.waitApplied(undefined, 20000);
      const wall = Date.now() - t0;
      assert.equal(new Set(roots).size, 1, roots.join(","));
      const proved = c.nodes[0]!.events.find((e) => e.event === "proved");
      assert.equal(proved?.n, 2);
      assert.ok(wall < 90000, `wall ${wall}`);
    } finally {
      c.stop();
      delete process.env.UEP_P4_CAROL;
    }
  });
});
