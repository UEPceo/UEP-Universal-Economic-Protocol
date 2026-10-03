/**
 * Pin verifying key: lab verifiers use the pinned key for (circuit version,
 * depth, domain) and never the key that travels with a proof.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loadVkPins, pinnedVk, zkVerifyPinned } from "./zk-vk-pins.ts";
import { zkProveExportD4 } from "./zk-bridge.ts";
import { publicInputsFromHex, normalizeFrHex } from "./zk-public-inputs.ts";
import { verifyZkSpendProofAgainstExpected, LAB_ZK_DOMAIN_ID } from "./zk-spend-provider.ts";
import { verifyArtifactAgainstRoots } from "./uep38-node-verify.ts";
import { VerifyingKeyRegistry } from "./verifying-key-registry.ts";

const other = JSON.parse(
  readFileSync(new URL("./fixtures/vk-pin-other-key.json", import.meta.url), "utf8"),
) as { publicInputsHex: string[]; vkHex: string; proofHex: string };

describe("pin verifying key", () => {
  it("the development key matches its pin for depth 4 and 32", () => {
    const pins = loadVkPins();
    for (const depth of [4, 32]) {
      const vk = pinnedVk(depth, 1n);
      const pin = pins.find((p) => p.depth === depth && p.circuitTag === vk.circuitTag);
      assert.ok(pin, `pin for depth ${depth}`);
      assert.equal(vk.vkSha256, pin!.vkSha256);
    }
  });

  it("an honest proof verifies under the pinned key", () => {
    const art = zkProveExportD4();
    assert.equal(art.ok, true);
    const v = zkVerifyPinned(4, 1n, art.proofHex, art.publicInputsHex);
    assert.equal(v.ok, true, v.raw);
    assert.equal(normalizeFrHex(art.vkHex), normalizeFrHex(pinnedVk(4).vkHex));
  });

  it("a proof under a key other than the pinned key is rejected", () => {
    assert.notEqual(other.vkHex, pinnedVk(4).vkHex);
    // Carried key differs from the pin: rejected before verification.
    assert.equal(zkVerifyPinned(4, 1n, other.proofHex, other.publicInputsHex, other.vkHex).code, "VK_NOT_PINNED");
    // Without the carried key, the proof does not verify under the pinned key.
    assert.equal(zkVerifyPinned(4, 1n, other.proofHex, other.publicInputsHex).code, "INVALID_PROOF");

    const proof = {
      kind: "zk-spend" as const,
      protocolVersion: "test",
      circuitTag: "test",
      backend: "test",
      vkHex: other.vkHex,
      proofHex: other.proofHex,
      publicInputsHex: other.publicInputsHex,
      publicInputs: publicInputsFromHex(other.publicInputsHex.slice(0, 12)),
    };
    assert.equal(verifyZkSpendProofAgainstExpected(proof, proof.publicInputs, LAB_ZK_DOMAIN_ID), false);
    assert.equal(verifyZkSpendProofAgainstExpected({ ...proof, vkHex: undefined }, proof.publicInputs, LAB_ZK_DOMAIN_ID), false);

    const art = { ok: true, vkHex: other.vkHex, proofHex: other.proofHex, publicInputsHex: other.publicInputsHex, newRootProof: other.publicInputsHex[1]! } as never;
    const r = verifyArtifactAgainstRoots(art, other.publicInputsHex[0]!);
    assert.deepEqual(r, { ok: false, reason: "VK_NOT_PINNED" });
    const r2 = verifyArtifactAgainstRoots({ ...(art as object), vkHex: "" } as never, other.publicInputsHex[0]!);
    assert.deepEqual(r2, { ok: false, reason: "GROTH16_VERIFY_FAIL" });
  });

  it("the depth and the domain select the pin", () => {
    const art = zkProveExportD4();
    assert.equal(zkVerifyPinned(32, 1n, art.proofHex, art.publicInputsHex).ok, false);
    assert.equal(zkVerifyPinned(8, 1n, art.proofHex, art.publicInputsHex).code, "VK_NOT_PINNED");
    assert.equal(zkVerifyPinned(4, 2n, art.proofHex, art.publicInputsHex).code, "VK_NOT_PINNED");
  });

  it("a key registry only admits pinned keys", () => {
    const reg = new VerifyingKeyRegistry();
    assert.throws(() => reg.pin({ networkId: "local", vkId: "x", vkHex: other.vkHex }), /VK_PIN_MISMATCH/);
    reg.pin({ networkId: "local", vkId: "dev-d4", vkHex: pinnedVk(4).vkHex });
    assert.equal(reg.isPinned("local", "dev-d4"), true);
  });
});
