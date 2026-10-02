import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { P4ProcessCluster, waitEvent } from "./uep38-p4-process-cluster.ts";

describe("UEP-38.29 lagging replica restart", () => {
  it("missed proposal, killed, restarted from empty disk, same root", async () => {
    const c = new P4ProcessCluster();
    try {
      await c.start(4, 4, ["p4-3"]);
      await c.propose(1000n, 1, "p4-0");
      const live = await c.waitApplied(["p4-0", "p4-1", "p4-2"], 90000);
      assert.equal(new Set(live).size, 1);
      const fresh = await c.respawn("p4-3");
      assert.equal(fresh.events.some((e) => e.event === "applied" && !e.dup), false);
      c.requestCatchup("p4-3");
      c.flushCommits("p4-0");
      await waitEvent(fresh, (e) => e.event === "applied" && !e.dup, 30000);
      const roots = await c.waitApplied(20000);
      assert.equal(new Set(roots).size, 1, roots.join(","));
      assert.equal(roots[0], live[0]);
    } finally {
      c.stop();
    }
  });
});
