import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalSpendId, claimFreshNullifier, type SpendProofArtifact } from "./uep38-node-verify.ts";

function art(nullifier: string): SpendProofArtifact {
  const pubs = Array.from({ length: 12 }, () => "ab".repeat(32));
  pubs[10] = nullifier;
  return { ok: true, vkHex: "aa", proofHex: "bb", publicInputsHex: pubs, oldRootProof: pubs[0]!, newRootProof: pubs[1]!, stdout: "", stderr: "" };
}

describe("apply rechecks nullifier", () => {
  it("second claim of the same nullifier is rejected, including a catch-up replay", () => {
    const seen = new Set<string>();
    const id = canonicalSpendId("uep-p4-lab", "alice", "n1");
    assert.equal(id, "uep-p4-lab|alice|n1");
    assert.equal(claimFreshNullifier(seen, art("11".repeat(32))).ok, true);
    const again = claimFreshNullifier(seen, art("11".repeat(32)));
    assert.equal(again.ok, false);
    assert.equal(again.reason, "NULLIFIER_REPLAY");
    assert.equal(claimFreshNullifier(seen, art("")).ok, false);
  });
});
