import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { P4ProcessCluster } from "./uep38-p4-process-cluster.ts";

describe("UEP-38.27 P4 mesh spend certificate", () => {
  it("four processes apply only after replica spend cert and share the root", async () => {
    const c = new P4ProcessCluster();
    try {
      await c.start(4, 4);
      await c.propose(1000n, 1, "p4-0");
      const roots = await c.waitApplied(90000);
      assert.equal(roots.length, 4);
      assert.equal(new Set(roots).size, 1, roots.join(","));
      const fails = c.nodes.flatMap((n) => n.events.filter((e) => e.event === "apply_fail"));
      assert.equal(fails.length, 0, JSON.stringify(fails));
    } finally {
      c.stop();
    }
  });
});
