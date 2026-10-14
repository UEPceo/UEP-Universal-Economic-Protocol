import { clientBlinding } from "../core/client-note.ts";
/**
 * Audit regression: outstanding issuer-mint reservations count against the registry supplyCap.
 * Before the fix, two reservations of 900 against a cap of 1000 both prepared and both applied (1800 issued).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AssetRegistry, buildSignedAssetRegistry } from "../core/asset-registry.ts";
import { INTERPLANETARY_ASSETS } from "../core/assets.ts";
import { generateEd25519KeyPair, signEd25519 } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { UepLedger, issuerMintMessage, type IssuerMintRequest } from "./ledger.ts";

const SNAP = generateEd25519KeyPair(), FAUCET = generateEd25519KeyPair(), GOV = generateEd25519KeyPair(), NS = generateEd25519KeyPair();
const ISSUERS = [generateEd25519KeyPair(), generateEd25519KeyPair(), generateEd25519KeyPair()];
const IPN = "uep-interplanetary-1", SENERGY = "uep-sim/senergy";
const tmpl = (a: any, over: any = {}) => { const { issuer: _i, network: _n, minProtocolFee, ...rest } = a; return { ...rest, ...(minProtocolFee !== undefined ? { minProtocolFee: minProtocolFee.toString() } : {}), issuer: { keys: [generateEd25519KeyPair().publicKeyHex] }, ...over } as never; };
const sign = (req: IssuerMintRequest) => ISSUERS.slice(0, 2).map((k) => ({ publicKey: k.publicKeyHex, signature: signEd25519(issuerMintMessage(req), k.privateKey) }));

function ledger() {
  const v1 = buildSignedAssetRegistry({ networkId: IPN, namespaces: [{ namespace: "uep-sim", owner: { keys: [NS.publicKeyHex] } }],
    assets: INTERPLANETARY_ASSETS.map((a) => tmpl(a, a.assetId === SENERGY ? { issuer: { keys: ISSUERS.map((k) => k.publicKeyHex), threshold: 2 }, supplyCap: "1000" } : {})),
    namespaceOwnerKeys: { "uep-sim": [NS.privateKey] }, governanceKeys: [GOV.privateKey] });
  const reg = AssetRegistry.load([v1], { keys: [GOV.publicKeyHex] });
  return new UepLedger({ networkId: IPN, domainId: "MARS", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, assetRegistry: reg } as any);
}

test("two outstanding reservations cannot jointly exceed the supplyCap", async () => {
  const l = ledger();
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const r1 = l.prepareIssuerMint(a.accountId, SENERGY, 900n, clientBlinding(314796266543n));
  assert.throws(() => l.prepareIssuerMint(a.accountId, SENERGY, 900n, clientBlinding(497818985519n)), /MINT_SUPPLY_CAP/);
  l.mintWithIssuerSignatures(r1, sign(r1), clientBlinding(314796266543n));
  assert.equal(l.balanceOfAsset(a.accountId, SENERGY), 900n);
  assert.throws(() => l.prepareIssuerMint(a.accountId, SENERGY, 101n, clientBlinding(46887142447n)), /MINT_SUPPLY_CAP/);
  const r2 = l.prepareIssuerMint(a.accountId, SENERGY, 100n, clientBlinding(229909861423n));
  l.mintWithIssuerSignatures(r2, sign(r2), clientBlinding(229909861423n));
  assert.equal(l.balanceOfAsset(a.accountId, SENERGY), 1000n);
});

test("a released reservation frees its share of the cap", async () => {
  const l = ledger();
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const r1 = l.prepareIssuerMint(a.accountId, SENERGY, 900n, clientBlinding(110673105967n));
  l.releaseIssuerMint(r1);
  const r2 = l.prepareIssuerMint(a.accountId, SENERGY, 900n, clientBlinding(476718543919n));
  l.mintWithIssuerSignatures(r2, sign(r2), clientBlinding(476718543919n));
  assert.equal(l.balanceOfAsset(a.accountId, SENERGY), 900n);
});
