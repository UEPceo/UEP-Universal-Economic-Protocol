import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { P4ProcessCluster, waitEvent } from "./uep38-p4-process-cluster.ts";
import { P4_PROCESS_VERSION } from "./uep38-p4-process-node.ts";

describe("UEP-38.19 P4 proposal delivery after view-change", () => {
  it("version", () => {
    assert.equal(P4_PROCESS_VERSION, "38.35");
  });

  it("all four replicas apply after TCP view-change without flush", async () => {
    const c = new P4ProcessCluster();
    try {
      await c.start(4, 4);
      c.requestViewChange(1);
      await c.waitView(1, 30000);
      await c.propose(1000n, 1, "p4-0");
      const rej = await waitEvent(
        c.nodes.find((n) => n.id === "p4-0")!,
        (e) => e.event === "reject" && e.reason === "NOT_LEADER",
        8000,
      );
      assert.equal(rej.leader, "p4-1");
      await c.propose(1000n, 1, "p4-1");
      await c.waitHeight(1, 90000);
      const roots = await c.waitApplied(undefined, 20000);
      assert.equal(new Set(roots).size, 1, roots.join(","));
    } finally {
      c.stop();
    }
  });
});
