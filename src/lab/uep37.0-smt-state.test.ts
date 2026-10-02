/**
 * UEP-37.0 regression — kept; uses testOnlyDepth fixtures.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SmtEconomicState, accountLabelToFr } from "./uep37-smt-economic-state.ts";
import { parallelSafeScheduleApply } from "./uep36-parallel-exec.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";

const fix = { testOnlyDepth: 16 as const, isTestFixture: true as const };

describe("UEP-37.0 SMT economic state (regression)", () => {
  it("genesis root deterministic", () => {
    const a = SmtEconomicState.genesis({ s0: 100n, r0: 0n }, fix);
    const b = SmtEconomicState.genesis({ s0: 100n, r0: 0n }, fix);
    assert.equal(a.stateRoot(), b.stateRoot());
  });

  it("same transfers → same root", () => {
    const a = SmtEconomicState.genesis({ s0: 1000n, s1: 1000n, r0: 0n, r1: 0n }, fix);
    const b = SmtEconomicState.genesis({ s0: 1000n, s1: 1000n, r0: 0n, r1: 0n }, fix);
    const txs = [
      { id: "t1", from: "s0", to: "r0", amount: 10n },
      { id: "t2", from: "s1", to: "r1", amount: 5n },
    ];
    assert.equal(a.applyBatch(txs).ok, true);
    assert.equal(b.applyBatch(txs).ok, true);
    assert.equal(a.stateRoot(), b.stateRoot());
  });

  it("sequential ≡ scheduled", () => {
    const eco = SmtEconomicState.genesis(
      { s0: 1000n, s1: 1000n, r0: 0n, r1: 0n },
      fix,
    );
    const r = parallelSafeScheduleApply(eco, [
      { id: "t1", from: "s0", to: "r0", amount: 3n },
      { id: "t2", from: "s1", to: "r1", amount: 4n },
    ]);
    assert.equal(r.fullStateEqual, true);
  });

  it("SMT root differs from LocalEconomicState SHA", () => {
    const bal = { s0: 100n, r0: 0n };
    const smt = SmtEconomicState.genesis(bal, { testOnlyDepth: 8, isTestFixture: true });
    const local = new LocalEconomicState(bal);
    smt.applyBatch([{ id: "x", from: "s0", to: "r0", amount: 1n }]);
    local.applyBatch([{ id: "x", from: "s0", to: "r0", amount: 1n }]);
    assert.notEqual(smt.stateRoot(), local.stateRoot());
  });

  it("accountLabelToFr deterministic", () => {
    assert.equal(accountLabelToFr("alice").toHex(), accountLabelToFr("alice").toHex());
  });

  it("multi-node test fixture depth converges", () => {
    const cluster = new MultiNodeCluster(4, 3700, {
      useSmtState: true,
      smtDepth: 16,
    });
    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "smt-1", from: "s0", to: "r0", amount: 7n }] },
    ]);
    assert.ok(prop);
    for (let i = 0; i < 80; i++) {
      cluster.tick(20, 5);
      if (cluster.allHonestSameStateRoot() &&
          cluster.nodes.filter((n) => !n.byzantine).every((n) => n.economic.sequence >= 1))
        break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
  });
});
