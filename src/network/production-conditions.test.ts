/** 0.5.84 item 4: production conditions (v1 signature sunset, asset registry mandatory by network type and height). */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { LegacyV1Policy } from "../marketplace/signature-v2.ts";
import { assertRegistryPolicy } from "../node/asset-registry-store.ts";
import { legacyV1ConfigFor, parseProductionConditions, registryPolicyFor, v1MigrationStatus } from "./production-conditions.ts";

const RAW = JSON.parse(readFileSync(new URL("../../config/production-conditions.json", import.meta.url), "utf8"));
const C = parseProductionConditions(RAW);
const quiet = (cfg: ReturnType<typeof legacyV1ConfigFor>) => cfg === false ? false : { ...cfg, warn: () => {} };

test("config/production-conditions.json parses; mainnet must refuse v1 and require the registry", () => {
  assert.throws(() => parseProductionConditions({ ...RAW, networks: { ...RAW.networks, mainnet: { ...RAW.networks.mainnet, v1Signatures: { mode: "absolute", sunsetHeight: 10 } } } }), /mainnet must refuse v1/);
  assert.throws(() => parseProductionConditions({ ...RAW, networks: { ...RAW.networks, mainnet: { ...RAW.networks.mainnet, assetRegistry: { required: false } } } }), /mainnet must require/);
  assert.throws(() => parseProductionConditions({ ...RAW, networks: { ...RAW.networks, testnet: { ...RAW.networks.testnet, v1Signatures: { mode: "absolute", sunsetHeight: -1 } } } }), /testnet.v1Signatures/);
});

test("v1 sunset: testnet uses one absolute height, so a node restarted later keeps the same sunset", () => {
  const sunset = RAW.networks.testnet.v1Signatures.sunsetHeight;
  const early = new LegacyV1Policy(quiet(legacyV1ConfigFor("testnet", C, 10)), 10, 1, false);
  const restarted = new LegacyV1Policy(quiet(legacyV1ConfigFor("testnet", C, sunset - 5)), sunset - 5, 1, false);
  assert.equal(early.sunsetHeight, sunset);
  assert.equal(restarted.sunsetHeight, sunset);
  restarted.assertAllowed("reservation", sunset - 1);
  assert.throws(() => restarted.assertAllowed("reservation", sunset), /LEGACY_V1_SIGNATURE_SUNSET/);
  assert.deepEqual(v1MigrationStatus("testnet", C, sunset - 100), { accepted: true, sunsetHeight: sunset, heightsLeft: 100 });
  assert.equal(v1MigrationStatus("testnet", C, sunset).accepted, false);
});

test("v1 sunset: mainnet refuses v1 from genesis; lab keeps the relative 0.5.83 default", () => {
  const main = new LegacyV1Policy(quiet(legacyV1ConfigFor("mainnet", C, 0)), 0, 1, false);
  assert.throws(() => main.assertAllowed("action:x", 0), /LEGACY_V1_SIGNATURE_REFUSED/);
  const lab = legacyV1ConfigFor("lab", C, 1000);
  assert.ok(lab !== false && lab.sunsetHeight === 1000 + RAW.networks.lab.v1Signatures.sunsetHeights);
});

test("asset registry: mainnet needs the ceremony's governance key set; testnet requires the registry from its announced height", () => {
  assert.throws(() => registryPolicyFor("mainnet", C, "uep-main"), /PRODUCTION_CONDITIONS_UNMET/);
  assert.throws(() => registryPolicyFor("testnet", C, "uep-testnet-1"), /PRODUCTION_CONDITIONS_UNMET/);
  // TEST-ONLY throwaway public key, created in memory; nothing is written.
  const gov = { keys: [generateEd25519KeyPair().publicKeyHex], threshold: 1 };
  const p = registryPolicyFor("testnet", C, "uep-testnet-1", gov);
  const from = RAW.networks.testnet.assetRegistry.requiredFromHeight;
  assert.equal(p.requireAssetRegistry, true);
  assert.equal(p.requiredFromHeight, from);
  assertRegistryPolicy(p, undefined, "uep-testnet-1", from - 1); // optional before the switch
  assert.throws(() => assertRegistryPolicy(p, undefined, "uep-testnet-1", from), /ASSET_REGISTRY_REQUIRED/);
  assert.throws(() => assertRegistryPolicy(p, undefined, "uep-testnet-1"), /ASSET_REGISTRY_REQUIRED/, "no height: conservative");
  assert.equal(registryPolicyFor("lab", C, "uep-lab").requireAssetRegistry, false);
});
