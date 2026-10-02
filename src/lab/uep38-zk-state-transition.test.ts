import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import { findBundledUepZk } from "./uep-zk-runner.ts";
import {
  UEP38_VERSION,
  defaultAlignedAccounts,
  bindCircuitAccounts,
  buildSpendJsonFromState,
  applyTransfer,
  proveTransition,
} from "./uep38-zk-state-transition.ts";

describe("UEP-38.0 Phase 4 SMT → Groth16", () => {
  it("version + binary", () => {
    assert.ok(UEP38_VERSION.startsWith("38."));
    assert.ok(findBundledUepZk());
  });

  it("bindAccountId changes poseidon root vs hashed labels", () => {
    const a = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const b = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const ids = defaultAlignedAccounts();
    bindCircuitAccounts(b, ids);
    assert.notEqual(a.stateRoot(), b.stateRoot());
  });

  it("local apply changes root and conserves", () => {
    const st = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const ids = defaultAlignedAccounts();
    bindCircuitAccounts(st, ids);
    const old = st.stateRoot();
    const r = applyTransfer(st, ids, 1000n);
    assert.equal(r.ok, true);
    assert.notEqual(r.newRoot, old);
    assert.equal(st.conservationOk(), true);
  });

  it("D=4 prove-spend-json roots match SMT before/after", () => {
    assert.ok(findBundledUepZk());
    const st = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const ids = defaultAlignedAccounts();
    bindCircuitAccounts(st, ids);
    const req = buildSpendJsonFromState(st, ids, 1000n);
    assert.equal(req.depth, 4);
    const out = proveTransition(st, ids, 1000n);
    assert.equal(out.ok, true, out.stderr + "\n" + out.stdout.slice(0, 800));
    assert.equal(out.rootsMatch, true);
  });
});
