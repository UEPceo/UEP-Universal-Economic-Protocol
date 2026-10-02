import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import { Fr } from "../core/field.ts";
import { labParty, proveWithoutApply } from "./uep38-zk-state-transition.ts";
import { assertPinnedVk, labAuthBodyFromArtifact, signSenderAuth, verifySenderAuth } from "./uep38-apply-guards.ts";

describe("apply guards", () => {
  it("pins the VK, requires the sender signature, and keeps the nullifier in state", () => {
    const ids = labParty("alice");
    const st = SmtEconomicState.genesis(
      { alice: 100000n, bob: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const art = proveWithoutApply(st, ids, 1000n);
    assert.equal(art.ok, true, art.stderr);
    assert.equal(assertPinnedVk(art, art.vkHex).ok, true);
    assert.equal(assertPinnedVk(art, "aa".repeat(32)).ok, false);
    const body = labAuthBodyFromArtifact(art);
    const auth = signSenderAuth(ids.senderSecret, body);
    assert.equal(verifySenderAuth(auth.publicKeyHex, body, auth.signature), true);
    assert.equal(verifySenderAuth(auth.publicKeyHex, body + "|x", auth.signature), false);
    const other = signSenderAuth("999", body);
    assert.equal(other.publicKeyHex === auth.publicKeyHex, false);
    const nf = art.publicInputsHex[10]!;
    assert.equal(st.insertNullifier(Fr.from("0x" + nf)).ok, true);
    const again = st.insertNullifier(Fr.from("0x" + nf));
    assert.equal(again.ok, false);
    const restored = st.clone();
    assert.equal(restored.insertNullifier(Fr.from("0x" + nf)).ok, false);
  });
});
