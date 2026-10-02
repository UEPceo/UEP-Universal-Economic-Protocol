import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { P4ProcessCluster, waitEvent } from "./uep38-p4-process-cluster.ts";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import { labParty, proveWithoutApply } from "./uep38-zk-state-transition.ts";

describe("nullifier replay on four processes", () => {
  it("a second proposal of the same nullifier is rejected", async () => {
    const ids = labParty("alice");
    const st = SmtEconomicState.genesis(
      { alice: 10000n, bob: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const art = proveWithoutApply(st, ids, 1000n);
    assert.equal(art.ok, true, art.stderr);
    process.env.UEP_P4_VK_HEX = art.vkHex;
    const c = new P4ProcessCluster();
    try {
      await c.start(4, 4);
      await c.propose(1000n);
      const roots = await c.waitApplied(90000);
      assert.equal(roots.length, 4);
      assert.ok(roots.every((r) => r === roots[0]));
      await c.replayNullifier();
      const rejected = await Promise.any(
        c.nodes.map((n) => waitEvent(n, (e) => (e.event === "apply_fail" || e.event === "reject") && e.reason === "NULLIFIER_REPLAY", 30000)),
      );
      assert.equal(rejected.reason, "NULLIFIER_REPLAY");
    } finally {
      c.stop();
    }
  });
});
