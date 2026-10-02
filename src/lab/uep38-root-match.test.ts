import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import { labParty, proveWithoutApply } from "./uep38-zk-state-transition.ts";

describe("TypeScript root matches Rust public input", () => {
  it("poseidon-zk genesis and the D=4 proof share old and new roots", () => {
    const ids = labParty("alice");
    const st = SmtEconomicState.genesis(
      { [ids.senderLabel]: 100000n, [ids.recipientLabel]: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const art = proveWithoutApply(st, ids, 1000n);
    assert.equal(art.ok, true, art.stderr || art.stdout);
    assert.equal(art.publicInputsHex.length, 13);
    assert.equal(art.publicInputsHex[0], st.stateRoot().replace(/^0x/, "").toLowerCase());
    assert.equal(art.publicInputsHex[12], "0000000000000000000000000000000000000000000000000000000000000001");
  });
});
