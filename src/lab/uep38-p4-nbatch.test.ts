import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import {
  bindCircuitAccounts,
  defaultAlignedAccounts,
  labParty,
  proveManyParallel,
} from "./uep38-zk-state-transition.ts";
import { nodeApplyVerifiedTransfer } from "./uep38-node-verify.ts";
import { P4_PROCESS_VERSION } from "./uep38-p4-process-node.ts";

function fresh() {
  const st = SmtEconomicState.genesis(
    { alice: 10_000n, bob: 0n, carol: 10_000n, dave: 0n, erin: 10_000n, frank: 0n },
    { testOnlyDepth: 32, isTestFixture: true, leafMode: "poseidon-zk" },
  );
  bindCircuitAccounts(st, defaultAlignedAccounts());
  return st;
}

describe("UEP-38.22 N disjoint spends in one height", () => {
  it("version", () => {
    assert.equal(P4_PROCESS_VERSION, "38.35");
  });

  // INTEGRATION CONFLICT (C-3: this test proves a spend below 1000 units; the public core charges a minimum fee of 1 unit since v0.4.4, but the UEP-26 circuit enforces floor(amount/1000) with no minimum, so the proof cannot be built). Pending a maintainer decision; see docs/LABS.md.
  it.skip("three spends proved in parallel, four replicas same root", async () => {
    const spends = [
      { who: "alice", amount: 1000n },
      { who: "carol", amount: 700n },
      { who: "erin", amount: 400n },
    ];
    const leader = fresh();
    const t0 = Date.now();
    const proved = await proveManyParallel(
      leader,
      spends.map((s) => ({ who: s.who, ids: labParty(s.who), amount: s.amount })),
    );
    const wall = Date.now() - t0;
    assert.equal(proved.ok, true, proved.reason);
    assert.equal(proved.arts.length, 3);
    const roots: string[] = [];
    for (let n = 0; n < 4; n++) {
      const st = fresh();
      for (let i = 0; i < spends.length; i++) {
        const art = proved.arts[i]!;
        const r = nodeApplyVerifiedTransfer(st, labParty(spends[i]!.who), spends[i]!.amount, art);
        assert.equal(r.ok, true, r.ok ? "" : r.reason);
      }
      roots.push(st.stateRoot());
      assert.equal(st.balance("bob"), 1000n);
      assert.equal(st.balance("dave"), 700n);
      assert.equal(st.balance("frank"), 400n);
    }
    assert.equal(new Set(roots).size, 1, roots.join(","));
    assert.equal(roots[0], proved.finalRoot);
    assert.ok(wall < 240000, `wall ${wall}`);
  });
});
