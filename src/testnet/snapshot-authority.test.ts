/**
 * v0.4.3 snapshot authority (UEP-B05): Ed25519 authority signatures, k-of-n
 * threshold, hash chain / checkpoints, and a dedicated faucet (mint) key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Fr } from "../core/field.ts";
import { hLeaf } from "../core/hash.ts";
import { encodeStringToFr } from "../core/encoding.ts";
import { makeNote } from "../core/note.ts";
import { generateEd25519KeyPair, signEd25519 } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";
import { UepLedger, checkpointOf, cosignSnapshot, mintMessage, snapshotHash, type UepLedgerSnapshot } from "./ledger.ts";
import { TESTNET } from "../network/profiles.ts";

const EUR = "asset:test:eur";
const asset = encodeStringToFr(EUR);
const S1 = generateEd25519KeyPair();
const S2 = generateEd25519KeyPair();
const S3 = generateEd25519KeyPair();
const FAUCET = generateEd25519KeyPair();
const TRUST = { authorities: [S1.publicKeyHex], faucetPublicKeys: [FAUCET.publicKeyHex] };
const identity = async () => identityFromMnemonic(await generateMnemonic(128));

function ledger(snapshotKeys = [S1.privateKey]) {
  return new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: snapshotKeys, faucetSigningKey: FAUCET.privateKey });
}

function pay(l: UepLedger, from: IdentitySecrets, to: Fr, amount: bigint) {
  const p = l.prepareSpend(from, to, EUR, amount);
  assert.ok("tx" in p); if (!("tx" in p)) throw new Error("prepare failed");
  const r = l.submit(p.tx, from);
  assert.ok("tx" in r);
}

/** Append a note, balance and mint record with the given signature, then let the ledger sign a snapshot with its snapshot key. */
function snapshotWithFakeMint(l: UepLedger, owner: Fr, sign: (message: string) => string): UepLedgerSnapshot {
  const note = makeNote(owner, asset, 1_000_000n, hLeaf(owner, new Fr(987654n)));
  const unsigned = { index: l.mints.length, networkId: l.networkId, domainId: l.domainId, account: owner.toHex(), assetId: asset.toHex(), amount: "1000000", commitment: note.commitment.toHex() };
  l.mints.push({ ...unsigned, signature: sign(mintMessage(unsigned)) });
  l.notes.push(note);
  (l as any).setBalance(owner, asset, l.balanceOf(owner, asset) + 1_000_000n);
  return l.snapshot(); // validly signed by the snapshot authority key
}

test("B05: honest 1-of-1 restore needs only public keys; a verify-only restore cannot sign or mint", async () => {
  const a = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  const snap = l.snapshot();
  assert.equal(snap.formatVersion, 3);
  assert.equal(snap.sequence, 1);
  assert.equal(snap.prevSnapshotHash, "0".repeat(64));
  assert.deepEqual(l.snapshotAuthorityPublicKeys(), [S1.publicKeyHex]);
  assert.equal(l.faucetPublicKey(), FAUCET.publicKeyHex);
  const restored = UepLedger.restore(structuredClone(snap), TRUST);
  assert.equal(restored.balanceOf(a.accountId, asset), 1_000n);
  assert.equal(restored.supply.get(asset.toHex()), 1_000n);
  assert.throws(() => restored.snapshot(), /SNAPSHOT_SIGNING_KEY_REQUIRED/);
  assert.throws(() => restored.faucet(a.accountId, EUR, 1n), /FAUCET_KEY_REQUIRED/);
});

test("B05: a snapshot signed by the wrong key is rejected", async () => {
  const a = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  const snap = l.snapshot();
  assert.throws(() => UepLedger.restore(snap, { ...TRUST, authorities: [S2.publicKeyHex] }), /INVALID_SNAPSHOT_THRESHOLD/);
  // A listed authority whose signature does not verify is an explicit signature failure.
  const badSig = structuredClone(snap);
  badSig.signatures[0]!.signature = signEd25519("something else", S1.privateKey);
  assert.throws(() => UepLedger.restore(badSig, TRUST), /INVALID_SNAPSHOT_SIGNATURE/);
});

test("B05: 2-of-3 threshold rejects a single signature and accepts two distinct signers", async () => {
  const a = await identity();
  const l = ledger([S1.privateKey]);
  l.faucet(a.accountId, EUR, 1_000n);
  const snap = l.snapshot();
  const trust = { authorities: [S1.publicKeyHex, S2.publicKeyHex, S3.publicKeyHex], threshold: 2, faucetPublicKeys: [FAUCET.publicKeyHex] };
  assert.throws(() => UepLedger.restore(snap, trust), /INVALID_SNAPSHOT_THRESHOLD: 1 distinct valid authority signature\(s\), 2 required/);
  const cosigned = cosignSnapshot(snap, S3.privateKey);
  assert.equal(UepLedger.restore(cosigned, trust).balanceOf(a.accountId, asset), 1_000n);
});

test("B05: a duplicate signer counts once toward the threshold", async () => {
  const a = await identity();
  const l = ledger([S1.privateKey]);
  l.faucet(a.accountId, EUR, 1_000n);
  const snap = l.snapshot();
  const trust = { authorities: [S1.publicKeyHex, S2.publicKeyHex, S3.publicKeyHex], threshold: 2, faucetPublicKeys: [FAUCET.publicKeyHex] };
  const duplicated = cosignSnapshot(snap, S1.privateKey);
  assert.equal(duplicated.signatures.length, 2);
  assert.throws(() => UepLedger.restore(duplicated, trust), /INVALID_SNAPSHOT_THRESHOLD/);
  const copied = { ...snap, signatures: [snap.signatures[0]!, { ...snap.signatures[0]! }] };
  assert.throws(() => UepLedger.restore(copied, trust), /INVALID_SNAPSHOT_THRESHOLD/);
  // Duplicate keys in the trust configuration itself are refused.
  assert.throws(() => UepLedger.restore(snap, { ...trust, authorities: [S1.publicKeyHex, S1.publicKeyHex] }), /INVALID_SNAPSHOT_TRUST/);
});

test("B05: a chain break or reordered chain is rejected even when every snapshot is correctly signed", async () => {
  const [a, b] = await Promise.all([identity(), identity()]);
  const l = ledger();
  l.faucet(a.accountId, EUR, 10_000n);
  const s1 = l.snapshot();
  pay(l, a, b.accountId, 1_000n);
  const s2 = l.snapshot();
  pay(l, a, b.accountId, 1_000n);
  const s3 = l.snapshot();
  assert.equal(s2.prevSnapshotHash, snapshotHash(s1));
  assert.equal(s3.prevSnapshotHash, snapshotHash(s2));
  // Direct link check.
  assert.ok(UepLedger.restore(s3, { ...TRUST, previousSnapshotHash: snapshotHash(s2) }));
  assert.throws(() => UepLedger.restore(s3, { ...TRUST, previousSnapshotHash: snapshotHash(s1) }), /INVALID_SNAPSHOT_CHAIN/);
  // Gap, reorder, and rollback to an older snapshot than the checkpoint.
  assert.throws(() => UepLedger.restoreChain([s1, s3], TRUST), /INVALID_SNAPSHOT_CHAIN/);
  assert.throws(() => UepLedger.restoreChain([s2, s1], TRUST), /INVALID_SNAPSHOT_CHAIN/);
  assert.throws(() => UepLedger.restore(s1, { ...TRUST, checkpoint: checkpointOf(s2) }), /INVALID_SNAPSHOT_CHAIN/);
  assert.equal(UepLedger.restoreChain([s1, s2, s3], TRUST).txs.length, 2);
});

test("B05: a rewritten history signed by the snapshot key is rejected against a known checkpoint", async () => {
  const [a, b, c] = await Promise.all([identity(), identity(), identity()]);
  const honest = ledger();
  honest.faucet(a.accountId, EUR, 10_000n);
  pay(honest, a, b.accountId, 1_000n);
  const checkpoint = checkpointOf(honest.snapshot());
  // Same keys, same mint, different history: the payment goes to c instead of b.
  const rewritten = ledger();
  rewritten.faucet(a.accountId, EUR, 10_000n);
  pay(rewritten, a, c.accountId, 1_000n);
  rewritten.snapshot();
  rewritten.snapshot();
  const forged = rewritten.snapshot(); // sequence 3, correctly signed
  assert.ok(UepLedger.restore(forged, TRUST), "internally valid on its own");
  assert.throws(() => UepLedger.restore(forged, { ...TRUST, checkpoint }), /INVALID_SNAPSHOT_HISTORY/);
});

test("B05: an unsigned faucet mint is rejected", async () => {
  const a = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  const forged = snapshotWithFakeMint(l, a.accountId, () => "");
  assert.throws(() => UepLedger.restore(forged, TRUST), /INVALID_SNAPSHOT_MINT_SIGNATURE/);
});

test("B05: a faucet mint signed by a foreign key is rejected", async () => {
  const a = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  const foreign = generateEd25519KeyPair();
  const forged = snapshotWithFakeMint(l, a.accountId, (m) => signEd25519(m, foreign.privateKey));
  assert.throws(() => UepLedger.restore(forged, TRUST), /INVALID_SNAPSHOT_MINT_SIGNATURE/);
});

test("B05: a forged history signed by the snapshot key with a fake mint is rejected (snapshot key cannot issue)", async () => {
  const [a, b] = await Promise.all([identity(), identity()]);
  const l = ledger();
  l.faucet(a.accountId, EUR, 10_000n);
  pay(l, a, b.accountId, 1_000n);
  const forged = snapshotWithFakeMint(l, b.accountId, (m) => signEd25519(m, S1.privateKey));
  assert.ok(forged.signatures.length === 1 && forged.signatures[0]!.publicKey === S1.publicKeyHex);
  assert.throws(() => UepLedger.restore(forged, TRUST), /INVALID_SNAPSHOT_MINT_SIGNATURE/);
  // Configuring the snapshot key as a faucet key is refused outright.
  assert.throws(() => UepLedger.restore(forged, { ...TRUST, faucetPublicKeys: [S1.publicKeyHex] }), /INVALID_SNAPSHOT_TRUST/);
  // A snapshot with mints cannot be restored without a faucet trust anchor.
  assert.throws(() => UepLedger.restore(forged, { authorities: [S1.publicKeyHex] }), /INVALID_SNAPSHOT_MINT_KEY/);
});

test("B05: faucet key must be distinct from snapshot keys; legacy shared secret is refused", () => {
  assert.throws(() => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [S1.privateKey], faucetSigningKey: S1.privateKey }), /FAUCET_KEY_NOT_DISTINCT/);
  assert.throws(() => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotAuthoritySecret: "x" } as any), /SNAPSHOT_SECRET_UNSUPPORTED/);
});

test("B05: an authority node resumes its chain after restore with its private keys", async () => {
  const [a, b] = await Promise.all([identity(), identity()]);
  const l = ledger();
  l.faucet(a.accountId, EUR, 10_000n);
  const s1 = l.snapshot();
  const node = UepLedger.restore(s1, TRUST, { snapshotSigningKeys: [S1.privateKey], faucetSigningKey: FAUCET.privateKey });
  node.faucet(b.accountId, EUR, 500n);
  pay(node, a, b.accountId, 1_000n);
  const s2 = node.snapshot();
  assert.equal(s2.sequence, 2);
  assert.equal(s2.prevSnapshotHash, snapshotHash(s1));
  const replica = UepLedger.restoreChain([s1, s2], TRUST);
  assert.equal(replica.supply.get(asset.toHex()), 10_500n);
  assert.equal(replica.stateRoot().toHex(), node.stateRoot().toHex());
  // Keys that are not trust anchors are refused.
  assert.throws(() => UepLedger.restore(s1, TRUST, { snapshotSigningKeys: [S2.privateKey] }), /SNAPSHOT_SIGNING_KEY_NOT_TRUSTED/);
});
