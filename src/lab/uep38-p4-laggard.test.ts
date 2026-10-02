import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { P4ProcessCluster, waitEvent } from "./uep38-p4-process-cluster.ts";

describe("UEP-38.28 lagging replica", () => {
  it("node that missed the proposal converges from the certified commit", async () => {
    const c = new P4ProcessCluster();
    try {
      await c.start(4, 4, ["p4-3"]);
      await c.propose(1000n, 1, "p4-0");
      const live = await c.waitApplied(["p4-0", "p4-1", "p4-2"], 90000);
      assert.equal(new Set(live).size, 1);
      const late = c.nodes.find((n) => n.id === "p4-3")!;
      assert.equal(late.events.some((e) => e.event === "applied" && !e.dup), false);
      await c.meshNode("p4-3");
      c.requestCatchup("p4-3");
      c.flushCommits("p4-0");
      await waitEvent(late, (e) => e.event === "applied" && !e.dup, 30000);
      const roots = await c.waitApplied(20000);
      assert.equal(roots.length, 4);
      assert.equal(new Set(roots).size, 1, roots.join(","));
    } finally {
      c.stop();
    }
  });
});
