/**
 * v0.5.3 (ADR 0001): the signed asset registry is wired into the ledger.
 * Unknown, unlisted or decimal-mismatched assets are refused; deprecated
 * assets cannot be minted; the fee floor comes from the registry; the
 * registry binding is committed in snapshot format 8 and checked on restore.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AssetRegistry, buildSignedAssetRegistry, type AssetDefinitionTemplate } from "../core/asset-registry.ts";
import { TESTNET_ASSETS, ledgerAssetIdToFr, type AssetRecord } from "../core/assets.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { UepLedger, type SnapshotTrust } from "./ledger.ts";
import { TESTNET } from "../network/profiles.ts";

const SNAP = generateEd25519KeyPair();
const FAUCET = generateEd25519KeyPair();
const GOV = generateEd25519KeyPair();
const NS = generateEd25519KeyPair();
const EUR = "uep-test/teur";
const BTC = "uep-test/tbtc";

const tmpl = (a: AssetRecord, over: Partial<AssetDefinitionTemplate> = {}): AssetDefinitionTemplate & { issuer: { keys: string[] } } => {
  const { issuer: _i, network: _n, minProtocolFee, ...rest } = a;
  return { ...rest, ...(minProtocolFee !== undefined ? { minProtocolFee: minProtocolFee.toString() } : {}), ...over, issuer: { keys: [generateEd25519KeyPair().publicKeyHex] } } as never;
};

function registry(assets: AssetRecord[], over: Record<string, Partial<AssetDefinitionTemplate>> = {}, previous?: ReturnType<typeof buildSignedAssetRegistry>) {
  return buildSignedAssetRegistry({
    networkId: TESTNET.networkId,
    previous,
    namespaces: [{ namespace: "uep-test", owner: { keys: [NS.publicKeyHex] } }],
    assets: assets.map((a) => tmpl(a, over[a.assetId])),
    namespaceOwnerKeys: { "uep-test": [NS.privateKey] },
    governanceKeys: [GOV.privateKey],
  });
}
const load = (chain: ReturnType<typeof registry>[]) => AssetRegistry.load(chain, { keys: [GOV.publicKeyHex] });
const ledger = (assetRegistry?: AssetRegistry) =>
  new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, assetRegistry, testOnlyUnboundedHeightAdvance: true });
const trust = (assetRegistry?: AssetRegistry): SnapshotTrust => ({ authorities: [SNAP.publicKeyHex], faucetPublicKeys: [FAUCET.publicKeyHex], ...(assetRegistry ? { assetRegistry } : {}) });
const code = (r: object) => ("error" in r ? (r as { error: { code: string } }).error.code : "OK");

test("registry: only listed assets are minted and spent; templates alone are not enough", async () => {
  const reg = load([registry(TESTNET_ASSETS.filter((a) => a.assetId !== BTC))]);
  const l = ledger(reg);
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const b = await identityFromMnemonic(await generateMnemonic(128));
  l.faucet(a.accountId, EUR, 10_000n);
  assert.throws(() => l.faucet(a.accountId, BTC, 10_000n), /Unknown TESTNET asset/);
  assert.equal(code(l.prepareSpend(a, b.accountId, BTC, 10n)), "ASSET_MISMATCH");
  assert.equal(l.assetRecord(BTC), undefined);
  // Without a registry the template still admits it (backward compatible).
  ledger().faucet(a.accountId, BTC, 1n);
});

test("registry: decimals must match the template (D-1, at most 8) and the network must match", () => {
  const reg = load([registry([...TESTNET_ASSETS], { [EUR]: { decimals: 3 } })]);
  assert.equal(ledger(reg).assetRecord(EUR), undefined);
  assert.ok(ledger(reg).assetRecord(BTC));
  assert.throws(() => load([registry([...TESTNET_ASSETS], { [EUR]: { decimals: 9 } })]));
  const other = AssetRegistry.load([buildSignedAssetRegistry({ networkId: "uep-global-1", namespaces: [], assets: [], namespaceOwnerKeys: {}, governanceKeys: [GOV.privateKey] })], { keys: [GOV.publicKeyHex] });
  assert.throws(() => ledger(other), /ASSET_REGISTRY_NETWORK_MISMATCH/);
});

test("registry: a deprecated asset cannot be minted; earlier mints stay valid; fee floor from registry", async () => {
  const v1 = registry([...TESTNET_ASSETS], { [EUR]: { minProtocolFee: "5" } });
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const l1 = ledger(load([v1]));
  l1.faucet(a.accountId, EUR, 100n);
  assert.equal(l1.feeFloorOf(ledgerAssetIdToFr(EUR)), 5n);
  assert.equal(ledger().feeFloorOf(ledgerAssetIdToFr(EUR)), 1n);
  const v2 = registry([...TESTNET_ASSETS], { [EUR]: { minProtocolFee: "5", status: "deprecated" } }, v1);
  const reg2 = load([v1, v2]);
  const l2 = ledger(reg2);
  assert.throws(() => l2.faucet(a.accountId, EUR, 1n), /ASSET_DISABLED/);
  // l1's history (minted under v1) restores under the v2 chain.
  const snap = l1.snapshot();
  assert.deepEqual(snap.assetRegistry, { networkId: TESTNET.networkId, version: 1, hash: v1.manifestHash });
  const r = UepLedger.restore(snap, trust(reg2));
  assert.equal(r.balanceOfAsset(a.accountId, EUR), 100n);
});

test("registry: snapshot binding is checked on restore", async () => {
  const reg = load([registry([...TESTNET_ASSETS])]);
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const l = ledger(reg);
  l.faucet(a.accountId, EUR, 50n);
  const snap = l.snapshot();
  assert.equal(snap.formatVersion, 8);
  assert.throws(() => UepLedger.restore(snap, trust()), /INVALID_SNAPSHOT_ASSET_REGISTRY/);
  const foreign = load([registry([...TESTNET_ASSETS])]);
  assert.throws(() => UepLedger.restore(snap, trust(foreign)), /not in the trusted registry chain/);
  assert.equal(UepLedger.restore(snap, trust(reg)).assetRegistry?.hash, reg.hash);
  // A template-only snapshot (binding null) can adopt a registry; its assets are re-checked.
  const plain = ledger();
  plain.faucet(a.accountId, BTC, 7n);
  const ps = plain.snapshot();
  assert.equal(ps.assetRegistry, null);
  assert.ok(UepLedger.restore(ps, trust(reg)));
  const noBtc = load([registry(TESTNET_ASSETS.filter((x) => x.assetId !== BTC))]);
  assert.throws(() => UepLedger.restore(ps, trust(noBtc)), /INVALID_SNAPSHOT_(NOTE|MINT)_ASSET/);
});
