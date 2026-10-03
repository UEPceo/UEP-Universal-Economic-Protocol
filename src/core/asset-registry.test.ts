/** v0.5.0 asset registry manifest (D-1/D-3): grammar, thresholds, separation, upgrades. Test-only ephemeral keys. */
import assert from "node:assert/strict";
import test from "node:test";
import { generateEd25519KeyPair } from "./ed25519.ts";
import {
  AssetRegistry, buildSignedAssetRegistry, cosignAssetRegistry, parseAssetId, selfCertifiedNamespace,
  assertAssetDecimals, meetsThreshold, signWith, normalizeKeySet, type SignedAssetRegistry,
  legacySelfCertifiedNamespace, selfCertifiedNamespaceVersion, assetIdToFr, isCanonicalAssetId,
} from "./asset-registry.ts";
import { readFileSync } from "node:fs";
import { encodeStringToFr } from "./encoding.ts";
import { BN254_FR_MODULUS } from "./field.ts";
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

// ---------------------------------------------------------------- V50-13: 130-bit self-certifying namespaces

function kManifest(ns: string, nsOwner: ReturnType<typeof k>, over: Partial<{ previous: SignedAssetRegistry; extra: Array<{ namespace: string; owner: ReturnType<typeof k> }>; allowLegacy: boolean; symbol: string }> = {}): SignedAssetRegistry {
  const extra = over.extra ?? [];
  const sym = over.symbol ?? "kwh";
  return buildSignedAssetRegistry({
    networkId: "uep-test-net",
    previous: over.previous,
    namespaces: [{ namespace: ns, owner: { keys: [nsOwner.publicKeyHex] } }, ...extra.map((e) => ({ namespace: e.namespace, owner: { keys: [e.owner.publicKeyHex] } }))],
    assets: [{ assetId: `${ns}/${sym}`, symbol: sym.toUpperCase(), name: "Energy", kind: "test-currency", decimals: 3, metadata: "", status: "experimental", issuer: { keys: [issuerB.publicKeyHex] } }],
    namespaceOwnerKeys: { [ns]: [nsOwner.privateKey], ...Object.fromEntries(extra.map((e) => [e.namespace, [e.owner.privateKey]])) },
    governanceKeys: gov.slice(0, 2).map((g) => g.privateKey),
    allowLegacySelfCertifiedNamespaces: over.allowLegacy,
  });
}

test("V50-13: self-certifying namespaces carry 130 bits (k- + 26 base32) and their ids are valid", () => {
  const o = k();
  const ns = selfCertifiedNamespace({ keys: [o.publicKeyHex] });
  assert.match(ns, /^k-[a-z2-7]{26}$/);
  assert.ok((ns.length - 2) * 5 >= 128);
  assert.equal(selfCertifiedNamespaceVersion(ns), 2);
  const longest = `${ns}/${"a".repeat(15)}`;
  assert.equal(Buffer.byteLength(longest), 44);
  assert.deepEqual(parseAssetId(longest), { namespace: ns, symbol: "a".repeat(15) });
  // Other namespaces keep the 31-byte bound; k- names of other lengths are not v2 names.
  assert.equal(isCanonicalAssetId(`${"x".repeat(15)}/${"a".repeat(15)}`), true);
  assert.equal(isCanonicalAssetId(`k-${"a".repeat(20)}/x`), false);
  assert.equal(isCanonicalAssetId(`k-${"a".repeat(27)}/x`), false);
  assert.equal(isCanonicalAssetId(`k-${"1".repeat(26)}/x`), false, "base32 alphabet only");
  const reg = AssetRegistry.load(kManifest(ns, o), governance);
  const a = reg.find(`${ns}/kwh`)!;
  assert.ok(a);
  assert.equal(reg.findByFr(a.fr)!.assetId, `${ns}/kwh`);
});

test("V50-13: a k- name that does not match its owner keys is rejected (v2 and legacy)", () => {
  const o = k();
  const mallory = k();
  const ns = selfCertifiedNamespace({ keys: [o.publicKeyHex] });
  assert.throws(() => AssetRegistry.load(kManifest(ns, mallory), governance), /self-certifying name does not match/);
  const legacy = legacySelfCertifiedNamespace({ keys: [o.publicKeyHex] });
  assert.throws(() => AssetRegistry.load(kManifest(legacy, mallory, { allowLegacy: true }), governance), /self-certifying name does not match/);
});

test("V50-13: field encoding stays injective; short ids keep their v0.5.0 encoding", () => {
  const ns = selfCertifiedNamespace({ keys: [k().publicKeyHex] });
  const ns2 = selfCertifiedNamespace({ keys: [k().publicKeyHex] });
  const symbols = ["a", "b", "aa", "a.", "a-", "a_", "0", "z9", "a".repeat(15), "-".repeat(15).replace(/^-/, "a"), "teur", "tbtc"];
  const seen = new Map<string, string>();
  for (const n of [ns, ns2]) for (const sym of symbols) {
    const id = `${n}/${sym}`;
    const fr = assetIdToFr(id);
    const v = BigInt("0x" + fr.toHex().replace(/^0x/, ""));
    assert.ok(v >= 1n << 248n && v < BN254_FR_MODULUS, id);
    assert.equal(seen.get(fr.toHex()), undefined, `collision ${id} / ${seen.get(fr.toHex())}`);
    seen.set(fr.toHex(), id);
  }
  for (const id of ["uep-test/teur", "uep-test/tbtc", `${"x".repeat(15)}/${"a".repeat(15)}`, `${legacySelfCertifiedNamespace({ keys: [k().publicKeyHex] })}/kwh`]) {
    assert.equal(assetIdToFr(id).toHex(), encodeStringToFr(id).toHex(), id);
    assert.ok(BigInt("0x" + assetIdToFr(id).toHex().replace(/^0x/, "")) < 1n << 248n);
  }
});

test("V50-13 compatibility: a frozen v0.5.0 manifest with a legacy 65-bit k- name still loads, same field encoding", () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/asset-registry-v0.5.0-legacy-k-namespace.json", import.meta.url), "utf8")) as { governance: { keys: string[]; threshold: number }; chain: SignedAssetRegistry[] };
  const ns = fx.chain[0]!.namespaces[0]!.namespace;
  assert.equal(selfCertifiedNamespaceVersion(ns), 1);
  const reg = AssetRegistry.load(fx.chain, fx.governance);
  const a = reg.find(`${ns}/kwh`)!;
  assert.ok(a);
  assert.equal(a.fr.toHex(), encodeStringToFr(`${ns}/kwh`).toHex());
  assert.equal(reg.hash, fx.chain[0]!.manifestHash);
});

test("V50-13 compatibility: legacy names cannot be newly admitted; existing ones survive upgrades", () => {
  const o = k();
  const legacy = legacySelfCertifiedNamespace({ keys: [o.publicKeyHex] });
  assert.match(legacy, /^k-[a-z2-7]{13}$/);
  // The builder refuses a new legacy name unless explicitly asked (compatibility fixtures).
  assert.throws(() => kManifest(legacy, o), /ASSET_REGISTRY_LEGACY_NAMESPACE/);
  const v1 = kManifest(legacy, o, { allowLegacy: true });
  const reg = AssetRegistry.load(v1, governance);
  // A version bump keeps the existing legacy name without the flag and may add a v2 name.
  const o2 = k();
  const fresh = selfCertifiedNamespace({ keys: [o2.publicKeyHex] });
  const v2 = kManifest(legacy, o, { previous: v1, extra: [{ namespace: fresh, owner: o2 }] });
  assert.equal(reg.withVersion(v2).version, 2);
  // A version bump that introduces another legacy name is rejected even if signed.
  const o3 = k();
  const another = legacySelfCertifiedNamespace({ keys: [o3.publicKeyHex] });
  const bad = kManifest(legacy, o, { previous: v1, extra: [{ namespace: another, owner: o3 }], allowLegacy: true });
  assert.throws(() => reg.withVersion(bad), /legacy 65-bit self-certifying name/);
});
