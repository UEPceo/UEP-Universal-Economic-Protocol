/**
 * v0.5.3 (ADR 0001): under an asset registry, mints use the manifest issuer
 * key set and its threshold (M-of-N). The faucet mints test assets only, the
 * registry supplyCap is enforced, and restore re-checks every issuer mint
 * against the manifest version it names. All keys are ephemeral.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AssetRegistry, buildSignedAssetRegistry, type AssetDefinitionTemplate } from "../core/asset-registry.ts";
import { INTERPLANETARY_ASSETS, TESTNET_ASSETS, type AssetRecord } from "../core/assets.ts";
import { generateEd25519KeyPair, signEd25519 } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { UepLedger, issuerMintMessage, signSnapshot, type IssuerMintRequest, type UepLedgerSnapshot } from "./ledger.ts";
import { TESTNET } from "../network/profiles.ts";

const SNAP = generateEd25519KeyPair();
const FAUCET = generateEd25519KeyPair();
const GOV = generateEd25519KeyPair();
const NS = generateEd25519KeyPair();
const ISSUERS = [generateEd25519KeyPair(), generateEd25519KeyPair(), generateEd25519KeyPair()];
const IPN = "uep-interplanetary-1";
const SENERGY = "uep-sim/senergy";

const tmpl = (a: AssetRecord, over: Partial<AssetDefinitionTemplate> & { issuer?: { keys: string[]; threshold?: number } } = {}) => {
  const { issuer: _i, network: _n, minProtocolFee, ...rest } = a;
  return { ...rest, ...(minProtocolFee !== undefined ? { minProtocolFee: minProtocolFee.toString() } : {}), issuer: { keys: [generateEd25519KeyPair().publicKeyHex] }, ...over } as never;
};

function ipnRegistry(over: Record<string, object> = {}) {
  const v1 = buildSignedAssetRegistry({
    networkId: IPN,
    namespaces: [{ namespace: "uep-sim", owner: { keys: [NS.publicKeyHex] } }],
    assets: INTERPLANETARY_ASSETS.map((a) => tmpl(a, a.assetId === SENERGY ? { issuer: { keys: ISSUERS.map((k) => k.publicKeyHex), threshold: 2 }, supplyCap: "1000", ...over } : {})),
    namespaceOwnerKeys: { "uep-sim": [NS.privateKey] },
    governanceKeys: [GOV.privateKey],
  });
  return AssetRegistry.load([v1], { keys: [GOV.publicKeyHex] });
}
const ipnLedger = (assetRegistry?: AssetRegistry) => new UepLedger({ networkId: IPN, domainId: "MARS", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, assetRegistry });
const sign = (req: IssuerMintRequest, keys: typeof ISSUERS) => keys.map((k) => ({ publicKey: k.publicKeyHex, signature: signEd25519(issuerMintMessage(req), k.privateKey) }));

test("issuer mint: 2-of-3 manifest issuer keys mint a non-test asset; the faucet cannot", async () => {
  const reg = ipnRegistry();
  const l = ipnLedger(reg);
  const a = await identityFromMnemonic(await generateMnemonic(128)); // in memory, discarded
  assert.throws(() => l.faucet(a.accountId, SENERGY, 10n), /FAUCET_TEST_ASSETS_ONLY/);
  const req = l.prepareIssuerMint(a.accountId, SENERGY, 400n);
  assert.equal(req.registryVersion, 1);
  assert.throws(() => l.mintWithIssuerSignatures(req, sign(req, ISSUERS.slice(0, 1))), /MINT_ISSUER_THRESHOLD/);
  // Two signatures by the same key count once; an outsider's key does not count.
  const one = sign(req, ISSUERS.slice(0, 1));
  assert.throws(() => l.mintWithIssuerSignatures(req, [...one, ...one]), /MINT_ISSUER_THRESHOLD/);
  assert.throws(() => l.mintWithIssuerSignatures(req, [...one, ...sign(req, [FAUCET])]), /MINT_ISSUER_THRESHOLD/);
  // A changed amount is not what the issuers signed.
  assert.throws(() => l.mintWithIssuerSignatures({ ...req, amount: "401" }, sign(req, ISSUERS.slice(0, 2))), /MINT_ISSUER_THRESHOLD|MINT_REQUEST_STALE/);
  l.mintWithIssuerSignatures(req, sign(req, ISSUERS.slice(1, 3)));
  assert.equal(l.balanceOfAsset(a.accountId, SENERGY), 400n);
  assert.equal(l.mints[0]!.issuerSignatures!.length, 2);
  assert.equal(l.mints[0]!.signature, "");
  // The request is single-use: replaying it is stale.
  assert.throws(() => l.mintWithIssuerSignatures(req, sign(req, ISSUERS.slice(0, 2))), /MINT_REQUEST_STALE/);
  // Supply cap 1000.
  const big = l.prepareIssuerMint(a.accountId, SENERGY, 600n);
  l.mintWithIssuerSignatures(big, sign(big, ISSUERS));
  assert.throws(() => l.prepareIssuerMint(a.accountId, SENERGY, 1n), /MINT_SUPPLY_CAP/);
  // Without a registry there is no issuer-mint path (templates only, unchanged faucet behaviour).
  assert.throws(() => ipnLedger().prepareIssuerMint(a.accountId, SENERGY, 1n), /MINT_REGISTRY_REQUIRED/);
});

test("issuer mint: restore re-checks the threshold against the named manifest version", async () => {
  const reg = ipnRegistry();
  const l = ipnLedger(reg);
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const req = l.prepareIssuerMint(a.accountId, SENERGY, 50n);
  l.mintWithIssuerSignatures(req, sign(req, ISSUERS.slice(0, 2)));
  const snap = l.snapshot();
  const trust = { authorities: [SNAP.publicKeyHex], assetRegistry: reg }; // no faucet key needed
  assert.equal(UepLedger.restore(structuredClone(snap), trust).balanceOfAsset(a.accountId, SENERGY), 50n);
  const resign = (mut: (p: Record<string, any>) => void): UepLedgerSnapshot => {
    const { snapshotHash: _h, signatures: _s, ...p } = structuredClone(snap) as unknown as Record<string, any>;
    mut(p);
    return signSnapshot(p as never, [SNAP.privateKey]);
  };
  assert.throws(() => UepLedger.restore(resign((p) => { p.mints[0].issuerSignatures = p.mints[0].issuerSignatures.slice(0, 1); }), trust), /INVALID_SNAPSHOT_MINT_SIGNATURE/);
  assert.throws(() => UepLedger.restore(resign((p) => { p.mints[0].registryVersion = 2; }), trust), /INVALID_SNAPSHOT_MINT_SIGNATURE/);
  assert.throws(() => UepLedger.restore(structuredClone(snap), { authorities: [SNAP.publicKeyHex] }), /INVALID_SNAPSHOT_ASSET_REGISTRY|INVALID_SNAPSHOT_MINT/);
});

test("issuer mint: test assets keep the faucet under a registry; the supply cap applies to them too", async () => {
  const v1 = buildSignedAssetRegistry({
    networkId: TESTNET.networkId,
    namespaces: [{ namespace: "uep-test", owner: { keys: [NS.publicKeyHex] } }],
    assets: TESTNET_ASSETS.map((a) => tmpl(a, a.assetId === "uep-test/teur" ? { supplyCap: "100" } : {})),
    namespaceOwnerKeys: { "uep-test": [NS.privateKey] },
    governanceKeys: [GOV.privateKey],
  });
  const reg = AssetRegistry.load([v1], { keys: [GOV.publicKeyHex] });
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, assetRegistry: reg });
  const a = await identityFromMnemonic(await generateMnemonic(128));
  l.faucet(a.accountId, "uep-test/teur", 60n);
  assert.throws(() => l.faucet(a.accountId, "uep-test/teur", 41n), /MINT_SUPPLY_CAP/);
  l.faucet(a.accountId, "uep-test/teur", 40n);
  assert.ok(UepLedger.restore(l.snapshot(), { authorities: [SNAP.publicKeyHex], faucetPublicKeys: [FAUCET.publicKeyHex], assetRegistry: reg }));
});
