import { clientBlinding } from "../core/client-note.ts";
/**
 * v0.5.4: prepared-output lifecycle, real binding, pending indexes,
 * reserved issuer mints, hFoldV2, blinding domain separation, network tag.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Domain, hFold, hFoldV2, migrateFold } from "../core/hash.ts";
import { SPEND_CIRCUIT_TAG, spendCircuitTxCommitment } from "../core/spend-circuit-freeze.ts";
import { Fr } from "../core/field.ts";
import { deriveNoteBlinding, walletDomainSeparator } from "../core/note.ts";
import { settlementRoot, settlementRootV2 } from "../core/reconciliation.ts";
import { setPoseidonWasm, poseidonBackendName } from "../core/poseidon-wasm.ts";
import { poseidon2 } from "../core/poseidon.ts";
import { PoseidonBn254Hash, setHashBackend } from "../core/hash.ts";
import { UepLedger, issuerMintMessage } from "./ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { generateEd25519KeyPair, signEd25519 } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { AssetRegistry, buildSignedAssetRegistry } from "../core/asset-registry.ts";
import { INTERPLANETARY_ASSETS } from "../core/assets.ts";

test("hFoldV2 binds length and version; hFold singleton identity is unchanged", () => {
  const x = new Fr(7);
  assert.equal(hFold(Domain.Transaction, [x]).toHex(), x.toHex());
  assert.notEqual(hFoldV2(Domain.Transaction, [x]).toHex(), x.toHex());
  assert.notEqual(hFoldV2(Domain.Transaction, [x]).toHex(), hFoldV2(Domain.Transaction, [x, x]).toHex());
  assert.equal(migrateFold(Domain.Transaction, [x], 1).toHex(), hFold(Domain.Transaction, [x]).toHex());
  assert.equal(migrateFold(Domain.Transaction, [x], 2).toHex(), hFoldV2(Domain.Transaction, [x]).toHex());
  assert.notEqual(settlementRoot([]).toHex(), settlementRootV2([]).toHex());
});

test("SpendCircuit transaction commitment is frozen on hFoldV2", () => {
  const z = new Fr(0);
  const c = spendCircuitTxCommitment({
    oldStateRoot: z, newStateRoot: z, oldNullifierRoot: z, newNullifierRoot: z,
    senderId: new Fr(1), recipientId: new Fr(2), treasuryId: new Fr(3), assetId: new Fr(4),
    amount: new Fr(5), fee: new Fr(1), nullifier: new Fr(6), domainId: new Fr(7),
  });
  const items = [new Fr(2), z, z, z, z, new Fr(1), new Fr(2), new Fr(3), new Fr(4), new Fr(5), new Fr(1), new Fr(6), new Fr(7)];
  assert.equal(c.toHex(), hFoldV2(Domain.Transaction, items).toHex());
  assert.notEqual(c.toHex(), hFold(Domain.Transaction, items).toHex());
  assert.equal(SPEND_CIRCUIT_TAG, "UEP-27-SPEND-POSEIDON-D32-v5-foldv2");
});

test("blinding is not a function of the public account id alone", () => {
  const account = new Fr(9);
  const ephemeral = new Fr(11);
  const domain = walletDomainSeparator("uep-testnet-1", "EARTH", "faucet");
  const blinding = deriveNoteBlinding(ephemeral, domain);
  assert.notEqual(blinding.toHex(), account.toHex());
  assert.notEqual(deriveNoteBlinding(ephemeral, domain).toHex(), deriveNoteBlinding(ephemeral, walletDomainSeparator("uep-testnet-1", "MARS", "faucet")).toHex());
});

test("prepared outputs expire without retaining blinding", async () => {
  const snap = generateEd25519KeyPair();
  const faucet = generateEd25519KeyPair();
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [snap.privateKey], faucetSigningKey: faucet.privateKey });
  const alice = await identityFromMnemonic(await generateMnemonic(128));
  const bob = await identityFromMnemonic(await generateMnemonic(128));
  l.faucet(l.addressOf(alice.accountId), "uep-test/teur", 100_000n, clientBlinding(592799441967n));
  const prepared = l.prepareSpend(alice, l.addressOf(bob.accountId), "uep-test/teur", 1_000n);
  assert.ok("tx" in prepared);
  const rec = l.preparedOutput(prepared.tx.txId.toHex());
  assert.equal(rec?.status, "prepared");
  assert.equal("blinding" in (rec as object), false);
  l.advanceHeight(l.policy.config.windowHeights);
  assert.equal(l.preparedOutput(prepared.tx.txId.toHex())?.status, "expired");
  l.rejectPrepared(prepared.tx.txId.toHex());
  const spent = l.submit(prepared.tx);
  assert.ok("tx" in spent, JSON.stringify((spent as { error?: unknown }).error));
  assert.equal(l.preparedOutput(prepared.tx.txId.toHex())?.status, "sent");
});

test("concurrent issuer prepares stay valid until applied in order", async () => {
  const snap = generateEd25519KeyPair();
  const faucet = generateEd25519KeyPair();
  const gov = generateEd25519KeyPair();
  const ns = generateEd25519KeyPair();
  const issuers = [generateEd25519KeyPair(), generateEd25519KeyPair()];
  const asset = INTERPLANETARY_ASSETS[0]!;
  const v1 = buildSignedAssetRegistry({
    networkId: "uep-interplanetary-1",
    namespaces: [{ namespace: "uep-sim", owner: { keys: [ns.publicKeyHex] } }],
    assets: [{ ...asset, minProtocolFee: asset.minProtocolFee?.toString(), issuer: { keys: issuers.map((k) => k.publicKeyHex), threshold: 1 } } as never],
    namespaceOwnerKeys: { "uep-sim": [ns.privateKey] },
    governanceKeys: [gov.privateKey],
  });
  const reg = AssetRegistry.load([v1], { keys: [gov.publicKeyHex] });
  const l = new UepLedger({ networkId: "uep-interplanetary-1", domainId: "MARS", connected: true, allowFaucet: true, snapshotSigningKeys: [snap.privateKey], faucetSigningKey: faucet.privateKey, assetRegistry: reg });
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const first = l.prepareIssuerMint(a.accountId, asset.assetId, 10n, clientBlinding(600120484911n));
  const second = l.prepareIssuerMint(a.accountId, asset.assetId, 12n, clientBlinding(827433948207n));
  assert.notEqual(first.index, second.index);
  assert.notEqual(first.commitment, second.commitment);
  const sign = (req: typeof first, key = issuers[0]!) => [{ publicKey: key.publicKeyHex, signature: signEd25519(issuerMintMessage(req), key.privateKey) }];
  assert.throws(() => l.mintWithIssuerSignatures(second, sign(second), clientBlinding(827433948207n)), /MINT_RESERVATION_HELD/);
  l.mintWithIssuerSignatures(first, sign(first), clientBlinding(600120484911n));
  l.mintWithIssuerSignatures(second, sign(second), clientBlinding(827433948207n));
  assert.equal(l.balanceOfAsset(a.accountId, asset.assetId), 22n);
  assert.throws(() => l.mintWithIssuerSignatures(first, sign(first), clientBlinding(600120484911n)), /MINT_REQUEST_STALE/);
});

test("snapshot persists policy windows and the network tag", async () => {
  const snap = generateEd25519KeyPair();
  const faucet = generateEd25519KeyPair();
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [snap.privateKey], faucetSigningKey: faucet.privateKey });
  const alice = await identityFromMnemonic(await generateMnemonic(128));
  const bob = await identityFromMnemonic(await generateMnemonic(128));
  l.faucet(l.addressOf(alice.accountId), "uep-test/teur", 100_000n, clientBlinding(917509891119n));
  const prepared = l.prepareSpend(alice, l.addressOf(bob.accountId), "uep-test/teur", 1_000n);
  assert.ok("tx" in prepared);
  assert.ok("tx" in l.submit(prepared.tx));
  const payload = l.snapshotPayload();
  assert.equal(payload.formatVersion, 10);
  assert.equal(payload.protocol, "UEP-25-prototype");
  assert.equal(payload.foldVersion, 2);
  assert.equal(payload.networkTag, l.networkTag());
  assert.ok(payload.policyWindows.length >= 1);
  const restored = UepLedger.restore(l.snapshot(), { authorities: [snap.publicKeyHex], faucetPublicKeys: [faucet.publicKeyHex] });
  assert.equal(restored.policy.windowVolume(alice.accountId.toHex(), "uep-test/teur", l.height) > 0n, true);
  const bad = structuredClone(prepared.tx);
  bad.protocol = "other";
  assert.equal(l.submit(bad).error?.code, "WRONG_NETWORK");
});

test("pending index and owner index", async () => {
  const snap = generateEd25519KeyPair();
  const faucet = generateEd25519KeyPair();
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [snap.privateKey], faucetSigningKey: faucet.privateKey });
  const alice = await identityFromMnemonic(await generateMnemonic(128));
  l.faucet(l.addressOf(alice.accountId), "uep-test/teur", 50_000n, clientBlinding(61477450799n));
  assert.equal(l.notesOf(alice.accountId).length, 1);
  const bob = await identityFromMnemonic(await generateMnemonic(128));
  const prepared = l.prepareSpend(alice, l.addressOf(bob.accountId), "uep-test/teur", 1_000n);
  assert.ok("tx" in prepared);
  const queued = l.enqueuePending(prepared.tx);
  assert.ok("tx" in queued);
  assert.equal(l.pendingTx(prepared.tx.txId.toHex())?.txId.toHex(), prepared.tx.txId.toHex());
  assert.ok(l.pendingByNullifier(prepared.tx.nullifier).includes(prepared.tx.txId.toHex()));
});

test("poseidon wasm contract matches the JS constants", () => {
  setPoseidonWasm({ poseidon2 });
  assert.equal(poseidonBackendName(), "uep-poseidon-bn254-x5-3-wasm-v1");
  const viaWasm = new Fr(poseidon2(1n, 2n)).toHex();
  setHashBackend(PoseidonBn254Hash);
  setPoseidonWasm(undefined);
  assert.equal(poseidonBackendName(), PoseidonBn254Hash.name);
  assert.equal(viaWasm, new Fr(poseidon2(1n, 2n)).toHex());
});
