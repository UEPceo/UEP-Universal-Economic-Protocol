import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { loadPinnedGovernance, verifyPinnedGovernance, governanceManifestHash } from "./pinned-governance.ts";
import { registryPolicyFor, parseProductionConditions } from "../network/production-conditions.ts";
import { meetsThreshold, normalizeKeySet } from "../core/asset-registry.ts";
import { signEd25519 } from "../core/ed25519.ts";

const set = () => JSON.parse(readFileSync("config/governance/uep-testnet-1.json", "utf8"));
const transcript = () => JSON.parse(readFileSync("docs/governance/uep-testnet-1-2026-10-16-transcript.json", "utf8"));

test("pinned testnet governance verifies (manifest hash, transcript hash, proofs of possession)", () => {
  const g = loadPinnedGovernance("uep-testnet-1");
  assert.equal(g.governance.threshold, 2);
  assert.equal(g.governance.keys.length, 3);
  assert.equal(g.effectiveHeight, 3153600);
  assert.equal(g.rotationPolicy.intervalMonths, 12);
  assert.equal(g.manifestHash, "b027fc18a8ed55e3d7ca61afcf1651223612e750fc282a643a784464bb76df31");
  assert.equal(g.transcriptHash, "7b9df8c0eb7b57b915fd3a9965acac5bae6ec5f2a567345d0ad83c5c25692b6c");
  const pc = parseProductionConditions(JSON.parse(readFileSync("config/production-conditions.json", "utf8")));
  const policy = registryPolicyFor("testnet", pc, g.networkId, g.governance);
  assert.equal(policy.requiredFromHeight, g.effectiveHeight, "activation height matches the approved testnet height");
});

test("tampered governance sets are rejected", () => {
  const t = transcript();
  const swapKey = set(); swapKey.governance.keys[0] = swapKey.governance.keys[1]; swapKey.manifestHash = governanceManifestHash(swapKey);
  assert.throws(() => verifyPinnedGovernance(swapKey, t), /GOVERNANCE_SET_INVALID/);
  const t1 = set(); t1.governance.threshold = 1; t1.manifestHash = governanceManifestHash(t1);
  assert.throws(() => verifyPinnedGovernance(t1, t), /GOVERNANCE_SET_INVALID/);
  const h = set(); h.effectiveHeight = 0;
  assert.throws(() => verifyPinnedGovernance(h, t), /manifest hash/);
  const badPop = transcript(); badPop.submissions[0].popSignatureHex = badPop.submissions[1].popSignatureHex;
  assert.throws(() => verifyPinnedGovernance(set(), badPop), /GOVERNANCE_SET_INVALID/);
});

test("2-of-3 is required (throwaway TEST-ONLY keys, same threshold as the pinned set)", () => {
  const pairs = [0, 1, 2].map(() => generateKeyPairSync("ed25519"));
  const raw = (k: import("node:crypto").KeyObject) => k.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const ks = normalizeKeySet({ keys: pairs.map(p => raw(p.publicKey)), threshold: loadPinnedGovernance("uep-testnet-1").governance.threshold }, "test");
  const msg = "uep-test-manifest-hash";
  const sig = (i: number) => ({ publicKey: raw(pairs[i]!.publicKey), signature: signEd25519(msg, pairs[i]!.privateKey) });
  assert.equal(meetsThreshold(msg, [sig(0)], ks), false, "one signature is not enough");
  assert.equal(meetsThreshold(msg, [sig(0), sig(0)], ks), false, "duplicate signer counts once");
  assert.equal(meetsThreshold(msg, [sig(0), sig(2)], ks), true);
  assert.equal(meetsThreshold(msg, [sig(1), sig(2)], ks), true);
  const outsider = generateKeyPairSync("ed25519");
  assert.equal(meetsThreshold(msg, [sig(0), { publicKey: raw(outsider.publicKey), signature: signEd25519(msg, outsider.privateKey) }], ks), false, "non-member does not count");
});
