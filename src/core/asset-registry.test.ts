/** v0.5.0 asset registry manifest (D-1/D-3): grammar, thresholds, separation, upgrades. Test-only ephemeral keys. */
import assert from "node:assert/strict";
import test from "node:test";
import { generateEd25519KeyPair } from "./ed25519.ts";
import {
  AssetRegistry, buildSignedAssetRegistry, cosignAssetRegistry, parseAssetId, selfCertifiedNamespace,
  assertAssetDecimals, meetsThreshold, signWith, normalizeKeySet, type SignedAssetRegistry,
} from "./asset-registry.ts";
import { devAssetRegistry } from "./assets.ts";
import { TESTNET } from "../network/profiles.ts";

const k = () => generateEd25519KeyPair();
const gov = [k(), k(), k()];
const owner = k();
const issuerA = [k(), k(), k()];
const issuerB = k();
const governance = { keys: gov.map((g) => g.publicKeyHex), threshold: 2 };

function manifest(over: Partial<{ decimals: number; issuerBKey: string; previous: SignedAssetRegistry; version: number; govKeys: typeof gov; dropB: boolean }> = {}): SignedAssetRegistry {
  return buildSignedAssetRegistry({
    networkId: "uep-test-net",
    previous: over.previous,
    version: over.version,
    namespaces: [{ namespace: "acme", owner: { keys: [owner.publicKeyHex] } }],
    assets: [
      { assetId: "acme/credit", symbol: "CREDIT", name: "Credit", kind: "test-currency", decimals: over.decimals ?? 2, metadata: "", status: "experimental", minProtocolFee: "1", supplyCap: "1000000", issuer: { keys: issuerA.map((i) => i.publicKeyHex), threshold: 2 } },
      ...(over.dropB ? [] : [{ assetId: "acme/kwh", symbol: "KWH", name: "Energy credit", kind: "resource-credit" as const, decimals: 3, unit: "kWh", measurement: { quantity: "energy", unit: "kWh", evidence: "signed meter telemetry" }, metadata: "", status: "experimental" as const, minProtocolFee: "5", supplyCap: "1000000", issuer: { keys: [over.issuerBKey ?? issuerB.publicKeyHex] } }]),
    ],
    namespaceOwnerKeys: { acme: [owner.privateKey] },
    governanceKeys: (over.govKeys ?? gov.slice(0, 2)).map((g) => g.privateKey),
  });
}

test("asset id grammar: <namespace>/<symbol>, bounded, lowercase", () => {
  assert.deepEqual(parseAssetId("uep-test/teur"), { namespace: "uep-test", symbol: "teur" });
  for (const bad of ["EUR", "uep-test/TEUR", "a/b/c", "/x", "x/", "-a/b", "averyveryverylongnamespace/x", "a/averyveryverylongsymbol"]) assert.throws(() => parseAssetId(bad), undefined, bad);
  assert.match(selfCertifiedNamespace({ keys: [owner.publicKeyHex] }), /^k-[a-z2-7]+$/);
});

test("decimals are bounded to 8", () => {
  assert.equal(assertAssetDecimals(8), 8);
  assert.throws(() => assertAssetDecimals(9));
  // The builder signs whatever it is given; loading (the security boundary) validates.
  assert.throws(() => AssetRegistry.load(manifest({ decimals: 9 }), governance), /decimals/);
});

test("threshold signatures count distinct valid keys only", () => {
  const ks = normalizeKeySet({ keys: issuerA.map((i) => i.publicKeyHex), threshold: 2 }, "issuer");
  const one = signWith("m", [issuerA[0]!.privateKey]);
  assert.equal(meetsThreshold("m", [...one, ...one], ks), false);
  assert.equal(meetsThreshold("m", [...one, ...signWith("m", [issuerB.privateKey])], ks), false);
  assert.equal(meetsThreshold("m", signWith("m", [issuerA[0]!.privateKey, issuerA[2]!.privateKey]), ks), true);
});

test("governance 2-of-3: one signature or a tampered manifest is rejected", () => {
  const signed = manifest();
  const reg = AssetRegistry.load(signed, governance);
  assert.equal(reg.version, 1);
  assert.equal(reg.find("acme/kwh")!.minProtocolFee, 5n);
  assert.throws(() => AssetRegistry.load(manifest({ govKeys: gov.slice(0, 1) }), governance), /ASSET_REGISTRY_SIGNATURE/);
  const tampered = structuredClone(signed);
  tampered.assets[0]!.supplyCap = "999999999";
  assert.throws(() => AssetRegistry.load(tampered, governance), /ASSET_REGISTRY/);
  // A third co-signature is fine.
  assert.equal(AssetRegistry.load(cosignAssetRegistry(manifest({ govKeys: gov.slice(0, 1) }), [gov[2]!.privateKey]), governance).version, 1);
});

test("key separation: issuer keys are per asset and distinct from owners and governance", () => {
  assert.throws(() => AssetRegistry.load(manifest({ issuerBKey: issuerA[0]!.publicKeyHex }), governance), /shared/);
  assert.throws(() => AssetRegistry.load(manifest({ issuerBKey: owner.publicKeyHex }), governance), /namespace owner/);
  const govAsIssuer = manifest({ issuerBKey: gov[2]!.publicKeyHex });
  assert.throws(() => AssetRegistry.load(govAsIssuer, governance), /governance keys must not be issuer keys/);
});

test("upgrades: version + 1 with previous hash; economics immutable; no removals", () => {
  const v1 = manifest();
  const reg = AssetRegistry.load(v1, governance);
  // Issuer rotation for acme/kwh through a version bump.
  const rotated = k();
  const v2 = manifest({ previous: v1, issuerBKey: rotated.publicKeyHex });
  const reg2 = reg.withVersion(v2);
  assert.equal(reg2.version, 2);
  assert.equal(reg2.issuerAt(1, "acme/kwh")!.keys[0], issuerB.publicKeyHex);
  assert.equal(reg2.issuerAt(2, "acme/kwh")!.keys[0], rotated.publicKeyHex);
  assert.throws(() => reg.withVersion(manifest({ previous: v1, decimals: 4 })), /immutable/);
  assert.throws(() => reg.withVersion(manifest({ previous: v1, dropB: true })), /removed/);
  assert.throws(() => reg.withVersion(manifest({ previous: v1, version: 3 })), /version/);
});

test("the development registry of the testnet loads (ephemeral keys, local only)", () => {
  const dev = devAssetRegistry(TESTNET.networkId);
  const reg = AssetRegistry.load(dev.chain, dev.governance);
  assert.ok(reg.find("uep-test/teur"));
  assert.ok(reg.list().every((a) => a.decimals <= 8));
});
