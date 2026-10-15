/**
 * 0.5.83 Block D: persistent, versioned governance of the signed asset manifest; snapshot binding;
 * store migration; a reference node (in-process and as a real CLI process) refuses to operate without
 * the registry when the network policy requires it.
 * TEST-ONLY KEYS: every key below is generated in memory per run, never written outside a temp dir,
 * never committed. No real key ceremony is performed or implied.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetRegistry, buildSignedAssetRegistry, type AssetDefinitionTemplate, type SignedAssetRegistry } from "../core/asset-registry.ts";
import { TESTNET_ASSETS, type AssetRecord } from "../core/assets.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { TESTNET } from "../network/profiles.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode, newNodeLedger } from "./assemble.ts";
import { ASSET_REGISTRY_STORE_FILE, AssetRegistryStore, assertRegistryPolicy, registryChainHash, type NetworkRegistryPolicy } from "./asset-registry-store.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// TEST-ONLY governance / namespace keys.
const GOV = generateEd25519KeyPair(), OTHER_GOV = generateEd25519KeyPair(), NS = generateEd25519KeyPair();
const tmpl = (a: AssetRecord): AssetDefinitionTemplate => {
  const { issuer: _i, network: _n, minProtocolFee, ...rest } = a;
  return { ...rest, ...(minProtocolFee !== undefined ? { minProtocolFee: minProtocolFee.toString() } : {}), issuer: { keys: [generateEd25519KeyPair().publicKeyHex] } } as never;
};
const TEMPLATES = TESTNET_ASSETS.map(tmpl);
const v1 = (gov = GOV) => buildSignedAssetRegistry({ networkId: TESTNET.networkId, namespaces: [{ namespace: "uep-test", owner: { keys: [NS.publicKeyHex] } }], assets: TEMPLATES, namespaceOwnerKeys: { "uep-test": [NS.privateKey] }, governanceKeys: [gov.privateKey] });
const bump = (prev: SignedAssetRegistry) => buildSignedAssetRegistry({ networkId: TESTNET.networkId, previous: prev, namespaces: prev.namespaces, assets: TEMPLATES.map((t, i) => ({ ...t, issuer: prev.assets[i]!.issuer })), namespaceOwnerKeys: { "uep-test": [NS.privateKey] }, governanceKeys: [GOV.privateKey] });
const policy = (require = true, gov = GOV): NetworkRegistryPolicy => ({ networkId: TESTNET.networkId, requireAssetRegistry: require, governance: { keys: [gov.publicKeyHex], threshold: 1 } });
const tmp = () => mkdtempSync(join(tmpdir(), "uep-reg-store-"));

test("Block D: install, governance-signed upgrade, atomic persistence and re-verification on reopen", () => {
  const dir = tmp();
  try {
    const s = AssetRegistryStore.open(dir, policy());
    assert.equal(s.registry, undefined);
    const m1 = v1();
    s.install([m1]);
    assert.equal(s.version, 1);
    const m2 = bump(m1);
    s.upgrade(m2);
    const re = AssetRegistryStore.open(dir, policy());
    assert.equal(re.version, 2);
    assert.equal(re.registry!.hash, m2.manifestHash);
    const file = JSON.parse(readFileSync(join(dir, ASSET_REGISTRY_STORE_FILE), "utf8"));
    assert.equal(file.storeVersion, 1);
    assert.equal(file.chainHash, registryChainHash(file.chain));
    // An upgrade signed by another key set is refused and nothing is written.
    const forged = buildSignedAssetRegistry({ networkId: TESTNET.networkId, previous: m2, namespaces: m2.namespaces, assets: TEMPLATES.map((t, i) => ({ ...t, issuer: m2.assets[i]!.issuer })), namespaceOwnerKeys: { "uep-test": [NS.privateKey] }, governanceKeys: [OTHER_GOV.privateKey] });
    assert.throws(() => re.upgrade(forged));
    assert.equal(AssetRegistryStore.open(dir, policy()).version, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Block D: tampered store, foreign governance, wrong network and rollback are refused", () => {
  const dir = tmp();
  try {
    const s = AssetRegistryStore.open(dir, policy());
    const m1 = v1(); s.install([m1]); s.upgrade(bump(m1));
    const path = join(dir, ASSET_REGISTRY_STORE_FILE);
    const good = readFileSync(path, "utf8");
    // Governance pinned by policy differs from the store's.
    assert.throws(() => AssetRegistryStore.open(dir, policy(true, OTHER_GOV)), /ASSET_REGISTRY_GOVERNANCE_MISMATCH/);
    // Content tamper (chain hash / signature).
    const f = JSON.parse(good); f.chain[1].assets[0].decimals = 7; writeFileSync(path, JSON.stringify(f));
    assert.throws(() => AssetRegistryStore.open(dir, policy()));
    const g = JSON.parse(good); g.chainHash = "00".repeat(32); writeFileSync(path, JSON.stringify(g));
    assert.throws(() => AssetRegistryStore.open(dir, policy()), /chain hash/);
    // Wrong network.
    writeFileSync(path, good);
    assert.throws(() => AssetRegistryStore.open(dir, { ...policy(), networkId: "uep-other-1" }), /NETWORK_MISMATCH/);
    // Rollback: the file is replaced by the version-1-only store while the ledger already binds version 2.
    const reg2 = AssetRegistryStore.open(dir, policy()).registry!;
    const bound = { version: reg2.version, hash: reg2.hash };
    const d2 = tmp();
    try {
      const old = AssetRegistryStore.open(d2, policy()); old.install([m1]);
      assert.throws(() => old.assertNotBehind(bound), /ASSET_REGISTRY_REGRESSION/);
      AssetRegistryStore.open(dir, policy()).assertNotBehind(bound);
    } finally { rmSync(d2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Block D: migration of the pre-0.5.83 layout (bare manifest / bare chain) to storeVersion 1", () => {
  for (const layout of ["bare", "array"] as const) {
    const dir = tmp();
    try {
      const m1 = v1();
      writeFileSync(join(dir, ASSET_REGISTRY_STORE_FILE), JSON.stringify(layout === "bare" ? m1 : [m1, bump(m1)]));
      const s = AssetRegistryStore.open(dir, policy());
      assert.equal(s.migratedFrom, 0);
      assert.equal(s.version, layout === "bare" ? 1 : 2);
      const file = JSON.parse(readFileSync(join(dir, ASSET_REGISTRY_STORE_FILE), "utf8"));
      assert.equal(file.format, "uep-asset-registry-store");
      assert.equal(AssetRegistryStore.open(dir, policy()).migratedFrom, null, "migration is persisted once");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("Block D: the snapshot binds the registry hash; restore needs the trusted chain; reference node refuses without registry", async () => {
  const reg = AssetRegistry.load([v1()], { keys: [GOV.publicKeyHex] });
  const snapshotKey = generateEd25519KeyPair(), faucetKey = generateEd25519KeyPair();
  const ledger = newNodeLedger({ snapshotKey, faucetKey, assetRegistry: reg });
  const snap = ledger.snapshot();
  assert.deepEqual((snap as { assetRegistry: unknown }).assetRegistry, { networkId: TESTNET.networkId, version: 1, hash: reg.hash });
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  assert.throws(() => UepLedger.restore(snap, trust), /ASSET_REGISTRY/);
  assert.equal(UepLedger.restore(snap, { ...trust, assetRegistry: reg }).assetRegistryBinding()!.hash, reg.hash);

  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  assert.throws(() => assembleNode({ custody, feeAccount, registryPolicy: policy() }), /NODE_REFUSES_TO_OPERATE: ASSET_REGISTRY_REQUIRED/);
  assert.throws(() => assembleNode({ custody, feeAccount, registryPolicy: policy(true, OTHER_GOV), assetRegistry: reg }), /NODE_REFUSES_TO_OPERATE/);
  const node = assembleNode({ custody, feeAccount, registryPolicy: policy(), assetRegistry: reg });
  assert.equal(node.ledger.assetRegistryBinding()!.version, 1);
  // Policy that does not require the registry: the node still starts without one (compatibility).
  assert.ok(assembleNode({ custody, feeAccount, registryPolicy: policy(false) }));
  assert.throws(() => assertRegistryPolicy({ networkId: TESTNET.networkId, requireAssetRegistry: true }, reg, TESTNET.networkId));
});

test("Block D: the reference node CLI process exits with NODE_REFUSES_TO_OPERATE without the required registry", () => {
  const dir = tmp();
  try {
    const pol = join(dir, "policy.json");
    writeFileSync(pol, JSON.stringify(policy()));
    const env = { ...process.env, UEP_DATA_DIR: join(dir, "data"), UEP_REGISTRY_POLICY: pol, UEP_PORT: "0", UEP_EXIT_AFTER_START: "1" };
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/node/cli.ts"], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /NODE_REFUSES_TO_OPERATE: ASSET_REGISTRY_REQUIRED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
