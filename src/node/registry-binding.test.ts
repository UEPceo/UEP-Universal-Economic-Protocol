/** Item 5 (0.5.81): certified commits record the asset registry they were applied under; it may only move forward. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetRegistry, buildSignedAssetRegistry, type AssetDefinitionTemplate } from "../core/asset-registry.ts";
import { TESTNET_ASSETS, type AssetRecord } from "../core/assets.ts";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { TESTNET } from "../network/profiles.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { BftConsensusKernel, type BftProposal } from "./bft-consensus.ts";
import { CertifiedCommitter, CommitLog } from "./certified-commit.ts";

const SNAP = generateEd25519KeyPair(), FAUCET = generateEd25519KeyPair(), GOV = generateEd25519KeyPair(), NS = generateEd25519KeyPair();
const EUR = "uep-test/teur";
const tmpl = (a: AssetRecord): AssetDefinitionTemplate => {
  const { issuer: _i, network: _n, minProtocolFee, ...rest } = a;
  return { ...rest, ...(minProtocolFee !== undefined ? { minProtocolFee: minProtocolFee.toString() } : {}), issuer: { keys: [generateEd25519KeyPair().publicKeyHex] } } as never;
};
const registry = () => AssetRegistry.load([buildSignedAssetRegistry({
  networkId: TESTNET.networkId, namespaces: [{ namespace: "uep-test", owner: { keys: [NS.publicKeyHex] } }],
  assets: TESTNET_ASSETS.map(tmpl), namespaceOwnerKeys: { "uep-test": [NS.privateKey] }, governanceKeys: [GOV.privateKey],
})], { keys: [GOV.publicKeyHex] });
const newLedger = (assetRegistry?: AssetRegistry) => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true,
  snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, ...(assetRegistry ? { assetRegistry } : {}) });

test("item 5: an APPLIED commit records the registry; applying under no registry or another manifest afterwards is refused", async () => {
  const reg = registry();
  const a = newLedger(reg);
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const payee = await identityFromMnemonic(await generateMnemonic(128));
  a.faucet(buyer.accountId, EUR, 50_050n, clientBlinding(3n));
  const vkeys = [0, 1, 2, 3].map(() => generateEd25519KeyPair());
  const validators = vkeys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex }));
  const domain = { networkId: a.networkId, domainId: a.domainId };
  const builder = new BftConsensusKernel(domain, validators, 1);
  const certify = (p: BftProposal) => {
    const lead = vkeys[Number(p.proposerId.slice(1))]!;
    const sig = builder.signProposal(p, lead.privateKey);
    const pc = builder.voteCertificate(p.height, p.round, "prevote", p.blockId, [0, 1, 2].map(i => builder.createVote(p, "prevote", `v${i}`, vkeys[i]!.privateKey, sig)));
    builder.observePrevoteCertificate(pc);
    const locked = { ...p, prevoteCertificate: pc };
    const lsig = builder.signProposal(locked, lead.privateKey);
    return { proposal: locked, proposalSignature: lsig, certificate: builder.voteCertificate(p.height, p.round, "precommit", p.blockId, [0, 1, 2].map(i => builder.createVote(locked, "precommit", `v${i}`, vkeys[i]!.privateKey, lsig))) };
  };
  const build = (l: UepLedger, amount: bigint, b: bigint) => {
    const r = l.preparePayment(buyer, payee.accountId, EUR, amount, l.height, { outputBlinding: clientBlinding(b), changeBlinding: clientBlinding(b + 1n) });
    if ("error" in r) throw new Error(r.error.code);
    return r.txs[0]!;
  };
  const dir = mkdtempSync(join(tmpdir(), "uep-reg-"));
  try {
    let current: UepLedger = a;
    const c = new CertifiedCommitter(new CommitLog(join(dir, "log.jsonl")), new BftConsensusKernel(domain, validators, 1), () => current);
    const tx1 = build(a, 100n, 10n);
    const h1 = a.height + 1;
    const r1 = c.applyCertifiedCommit({ ...certify({ ...domain, height: h1, round: 0, proposerId: builder.leader(h1, 0), parentRoot: a.stateRoot().toHex(), blockId: tx1.txId.toHex() }), tx: tx1 });
    assert.deepEqual(r1.registry, { version: reg.version, hash: reg.hash });

    // Same state, no registry: refused before anything is written.
    const tx2 = build(a, 101n, 12n);
    const h2 = h1 + 1;
    const input2 = { ...certify({ ...domain, height: h2, round: 0, proposerId: builder.leader(h2, 0), parentRoot: a.stateRoot().toHex(), blockId: tx2.txId.toHex() }), tx: tx2 };
    current = newLedger();
    const entries = c.log.all().length;
    assert.throws(() => c.applyCertifiedCommit(input2), /BFT_REGISTRY_REGRESSION/);
    // Another manifest at the same version: refused too.
    current = newLedger(registry());
    assert.throws(() => c.applyCertifiedCommit(input2), /BFT_REGISTRY_REGRESSION/);
    assert.equal(c.log.all().length, entries);
    // Back on the ledger with the recorded registry: the commit proceeds.
    current = a;
    assert.equal(c.applyCertifiedCommit(input2).status, "APPLIED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("item 5: under a registry, unlisted assets cannot be minted or prepared and the snapshot binding is enforced on restore", async () => {
  const reg = AssetRegistry.load([buildSignedAssetRegistry({
    networkId: TESTNET.networkId, namespaces: [{ namespace: "uep-test", owner: { keys: [NS.publicKeyHex] } }],
    assets: TESTNET_ASSETS.filter(x => x.assetId === EUR).map(tmpl), namespaceOwnerKeys: { "uep-test": [NS.privateKey] }, governanceKeys: [GOV.privateKey],
  })], { keys: [GOV.publicKeyHex] });
  const l = newLedger(reg);
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const other = TESTNET_ASSETS.find(x => x.assetId !== EUR)!.assetId;
  assert.throws(() => l.faucet(a.accountId, other, 1n, clientBlinding(5n)));
  l.faucet(a.accountId, EUR, 1_000n, clientBlinding(7n));
  const snap = l.snapshot();
  const trust = { authorities: [SNAP.publicKeyHex], faucetPublicKeys: [FAUCET.publicKeyHex] };
  assert.throws(() => UepLedger.restore(snap, trust), /ASSET_REGISTRY/);
  assert.equal(UepLedger.restore(snap, { ...trust, assetRegistry: reg }).assetRegistryBinding()?.hash, reg.hash);
});
