/**
 * v0.4.5: key-derived accounts and v2 addresses (UEP-ADDR-002).
 * Note owners commit to an Ed25519 spend key; spends reveal the key and sign,
 * so any replica verifies ownership without a spend-key registry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Fr } from "../core/field.ts";
import { encodeStringToFr } from "../core/encoding.ts";
import { hAccount } from "../core/hash.ts";
import { makeNote, serializeNote, deserializeNote } from "../core/note.ts";
import { computeTxCommitment, txIdFromCommitment, serializeTx, type UepTransaction } from "../core/transaction.ts";
import { ACCOUNT_ID_VERSION, accountIdFromSpendKey, isKeyDerivedAccountId, signSenderAuth, spendKeyHash } from "../core/spend-key.ts";
import { ADDRESS_HRP, addressFromSpendKey, addressNetworkTag, bech32mEncode, decodeAccountAddress, encodeAccountAddress, isValidBech32m, parseAccountAddress, UepAddressV1 } from "../core/address.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";
import { UepLedger, signSnapshot, type UepLedgerSnapshot } from "./ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";

const SNAPSHOT_KEY = generateEd25519KeyPair();
const FAUCET_KEY = generateEd25519KeyPair();
const TRUST = { authorities: [SNAPSHOT_KEY.publicKeyHex], faucetPublicKeys: [FAUCET_KEY.publicKeyHex] };
const NODE_KEYS = { snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey };
const NET = TESTNET.networkId;
const EUR = "asset:test:eur";
const asset = encodeStringToFr(EUR);

const identity = async () => identityFromMnemonic(await generateMnemonic(128));
const ledger = (extra: { testOnlyDisableProof?: boolean } = {}) => new UepLedger({ networkId: NET, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey, ...extra });
const resign = (snap: UepLedgerSnapshot) => signSnapshot(snap, [SNAPSHOT_KEY.privateKey]);
const code = (r: { error: { code: string } } | { tx: unknown }) => ("error" in r ? r.error.code : "OK");
function prepared(l: UepLedger, from: IdentitySecrets, to: Fr | string, amount: bigint): UepTransaction {
  const p = l.prepareSpend(from, to, EUR, amount);
  assert.ok("tx" in p, "error" in p ? p.error.message : "");
  return (p as { tx: UepTransaction }).tx;
}
/** Rebuild an envelope with new sender / outputs and sign it with `signer`'s spend key. */
function recrafted(base: UepTransaction, signer: IdentitySecrets, fields: { senderId?: Fr; outputs?: ReturnType<typeof makeNote>[] }): UepTransaction {
  const senderId = fields.senderId ?? base.senderId;
  const outputs = fields.outputs ?? base.outputNotes!.map(deserializeNote);
  const outputCommitments = outputs.map((o) => o.commitment);
  const transactionCommitment = computeTxCommitment({ networkId: base.networkId, domainId: base.domainId, senderId, recipientId: base.recipientId, assetId: base.assetId, amount: base.amount, fee: base.fee, nonce: base.nonce, nullifier: base.nullifier, inputCommitments: base.inputCommitments, outputCommitments });
  const txId = txIdFromCommitment(transactionCommitment, base.nullifier);
  const tx = { ...base, senderId, outputCommitments, outputNotes: outputs.map(serializeNote), transactionCommitment, txId };
  return { ...tx, senderAuth: signSenderAuth(tx, signer.secret, signer.salt) };
}

// ---------------------------------------------------------------- address format

test("address v2: key-derived account id and checksummed, versioned, network-bound encoding", async () => {
  const a = await identity();
  assert.ok(isKeyDerivedAccountId(a.accountId));
  assert.equal(a.accountId.n >> 248n, BigInt(ACCOUNT_ID_VERSION));
  assert.ok(accountIdFromSpendKey(a.spendPublicKey).eq(a.accountId));
  // The id is 0x02 || 31-byte key hash: a canonical field element (no reduction).
  assert.equal(a.accountId.toHex().slice(2), spendKeyHash(a.spendPublicKey).toString("hex"));
  const addr = addressFromSpendKey(NET, a.spendPublicKey);
  assert.equal(addr, encodeAccountAddress(NET, a.accountId));
  assert.match(addr, /^uep1[02-9ac-hj-np-z]{64}$/);
  assert.equal(addr.length, 68);
  assert.ok(isValidBech32m(addr));
  const d = decodeAccountAddress(addr, NET);
  assert.ok(d.ok && d.version === 2 && d.accountId.eq(a.accountId) && d.networkTag === addressNetworkTag(NET));
  assert.ok(parseAccountAddress(addr.toUpperCase(), NET).eq(a.accountId)); // all-uppercase is valid Bech32m
  // Legacy H(secret, salt) ids are not key-derived and cannot be encoded.
  assert.ok(!isKeyDerivedAccountId(hAccount(a.secret, a.salt)));
  assert.throws(() => encodeAccountAddress(NET, hAccount(a.secret, a.salt)), /ADDRESS_VERSION/);
  assert.throws(() => UepAddressV1.encode(NET, a.accountId), /ADDRESS_LEGACY_V1/);
});

test("address v2: checksum, version, HRP, network, case and legacy errors", async () => {
  const a = await identity();
  const addr = encodeAccountAddress(NET, a.accountId);
  const err = (s: string, net: string | undefined = NET) => { const r = decodeAccountAddress(s, net); return r.ok ? "OK" : r.code; };
  // Any single-character substitution is caught by the Bech32m checksum.
  for (const i of [4, 20, 40, 67]) {
    const c = addr[i] === "q" ? "p" : "q";
    assert.equal(err(addr.slice(0, i) + c + addr.slice(i + 1)), "ADDRESS_CHECKSUM");
  }
  // Transposition of two adjacent, different data characters (swapping equal ones is a no-op).
  let t = 30;
  while (addr[t] === addr[t + 1]) t++;
  assert.equal(err(addr.slice(0, t) + addr[t + 1] + addr[t] + addr.slice(t + 2)), "ADDRESS_CHECKSUM");
  // Correct checksum, unsupported version byte.
  const payload = Buffer.from([0x02, ...Buffer.from(addressNetworkTag(NET), "hex"), ...Buffer.from(a.accountId.toHex().slice(2), "hex")]);
  assert.equal(bech32mEncode(ADDRESS_HRP, payload), addr);
  assert.equal(err(bech32mEncode(ADDRESS_HRP, Buffer.from([0x03, ...payload.subarray(1)]))), "ADDRESS_VERSION");
  assert.equal(err(bech32mEncode(ADDRESS_HRP, payload.subarray(0, 30))), "ADDRESS_LENGTH");
  assert.equal(err(bech32mEncode("btc", payload)), "ADDRESS_HRP");
  assert.equal(err(encodeAccountAddress("uep-global-1", a.accountId)), "ADDRESS_NETWORK");
  assert.equal(err(addr.slice(0, 10) + addr.slice(10).toUpperCase()), "ADDRESS_FORMAT");
  assert.equal(err(`uep:${NET}:${hAccount(a.secret, a.salt).toHex()}`), "ADDRESS_LEGACY_V1");
  assert.equal(UepAddressV1.decode(`uep:${NET}:${a.accountId.toHex()}`), null);
  // BIP-350 reference vectors for the checksum itself.
  for (const v of ["A1LQFN3A", "a1lqfn3a", "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx", "?1v759aa"]) assert.ok(isValidBech32m(v), v);
  for (const v of ["abc1rzg", "1p2gdwpf", "a1lqfn3q", "M1VUXWEZ"]) assert.ok(!isValidBech32m(v), v);
});

test("ledger: faucet and spends accept v2 addresses and refuse invalid or legacy accounts", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  const bAddr = l.addressOf(b.accountId);
  l.faucet(l.addressOf(a.accountId), EUR, 10_000n);
  assert.throws(() => l.faucet(hAccount(a.secret, a.salt), EUR, 1n), /FAUCET_ACCOUNT_INVALID/);
  assert.throws(() => l.faucet(`uep:${NET}:${a.accountId.toHex()}`, EUR, 1n), /FAUCET_ACCOUNT_INVALID: ADDRESS_LEGACY_V1/);
  const flipped = bAddr.slice(0, 30) + (bAddr[30] === "q" ? "p" : "q") + bAddr.slice(31);
  for (const bad of [flipped, encodeAccountAddress("uep-global-1", b.accountId), hAccount(b.secret, b.salt)]) {
    assert.equal(code(l.prepareSpend(a, bad, EUR, 100n)), "INVALID_ADDRESS");
  }
  assert.equal(code(l.prepareSpend(a, TREASURY_ID, EUR, 100n)), "INVALID_PARTICIPANTS");
  // Honest spend to an address string; value is conserved across restore.
  const tx = prepared(l, a, bAddr, 1_000n);
  assert.ok(tx.recipientId.eq(b.accountId));
  assert.equal(code(l.submit(tx, a)), "OK");
  const restored = UepLedger.restore(l.snapshot(), TRUST);
  assert.equal(restored.balanceOf(b.accountId, asset), 1_000n);
  assert.equal(restored.balanceOf(a.accountId, asset) + restored.balanceOf(b.accountId, asset) + restored.balanceOf(TREASURY_ID, asset), 10_000n);
});

// ---------------------------------------------------------------- owner / key binding

test("owner binding: a note owned by an address whose key does not match the signer is rejected", async () => {
  const a = await identity(); const b = await identity(); const z = await identity();
  const l = ledger({ testOnlyDisableProof: true }); // isolate the public check from the development MAC
  l.faucet(a.accountId, EUR, 1_000n);
  const tx = prepared(l, a, b.accountId, 100n);
  // z signs a's spend (sender = a): z's key does not hash to a's account.
  const zSigned = { ...tx, senderAuth: signSenderAuth(tx, z.secret, z.salt) };
  // z claims to be the sender of a's note: the note owner does not match z.
  const outs = tx.outputNotes!.map(deserializeNote);
  const asZ = recrafted(tx, z, { senderId: z.accountId, outputs: [outs[0]!, makeNote(z.accountId, asset, outs[1]!.amount, outs[1]!.blinding)] });
  assert.equal(code(l.submit(zSigned)), "OWNER_KEY");
  assert.ok(["WRONG_OWNER", "OWNER_KEY"].includes(code(l.submit(asZ))));
  assert.equal(code(l.queueConflict(zSigned)), "OWNER_KEY");
  assert.ok(["WRONG_OWNER", "OWNER_KEY"].includes(code(l.queueConflict(asZ))));
  assert.equal(l.txs.length, 0);
  assert.equal(l.pending.length, 0);
  assert.equal(l.balanceOf(a.accountId, asset), 1_000n);
  // An arbitrary unrelated key value is refused the same way.
  assert.equal(code(l.submit({ ...tx, senderAuth: { publicKey: "00".repeat(32), signature: tx.senderAuth!.signature } })), "OWNER_KEY");
  // The honest owner's signature passes the public check.
  assert.equal(code(l.submit(tx)), "OK");
});

test("owner binding: a forged spend-key registry entry no longer matters", async () => {
  const a = await identity(); const b = await identity(); const z = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  const tx = prepared(l, a, b.accountId, 100n);
  const zSigned = { ...tx, senderAuth: signSenderAuth(tx, z.secret, z.salt) };
  // A registry mapping a's account to z's key, planted on the node object, is ignored.
  (l as unknown as { spendKeys: Map<string, unknown> }).spendKeys = new Map([[a.accountId.toHex(), { account: a.accountId.toHex(), publicKey: z.spendPublicKey, proof: "00" }]]);
  assert.equal(code(l.queueConflict(zSigned)), "OWNER_KEY");
  // A snapshot carrying a registry (as v0.4.4 did), signed by the authority, is refused.
  const snap = l.snapshot();
  const withRegistry = structuredClone(snap) as any;
  withRegistry.spendKeys = [{ account: a.accountId.toHex(), publicKey: z.spendPublicKey, proof: "00".repeat(64) }];
  assert.throws(() => UepLedger.restore(resign(withRegistry), TRUST), /INVALID_SNAPSHOT_SPEND_KEY/);
  // And the z-signed spend cannot ride in the pending queue of a signed snapshot.
  const poisoned = structuredClone(snap) as any;
  poisoned.pending.push(serializeTx(zSigned));
  assert.throws(() => UepLedger.restore(resign(poisoned), TRUST), /INVALID_SNAPSHOT_PENDING: OWNER_KEY/);
  assert.ok(UepLedger.restore(snap, TRUST));
});

test("restore: a key/owner mismatch in committed history or a non-key-derived note owner is rejected", async () => {
  const a = await identity(); const b = await identity(); const z = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  const tx = prepared(l, a, b.accountId, 100n);
  assert.equal(code(l.submit(tx, a)), "OK");
  const snap = l.snapshot();
  assert.ok(UepLedger.restore(structuredClone(snap), TRUST));
  // Replace the committed spend's signature by a valid signature with z's key.
  const swapped = structuredClone(snap) as any;
  swapped.txs[0].senderAuth = signSenderAuth(tx, z.secret, z.salt);
  assert.throws(() => UepLedger.restore(resign(swapped), TRUST), /INVALID_SNAPSHOT_OWNER_KEY/);
  // Strip the revealed key / signature.
  const stripped = structuredClone(snap) as any;
  stripped.txs[0].senderAuth = { publicKey: a.spendPublicKey, signature: "00".repeat(64) };
  assert.throws(() => UepLedger.restore(resign(stripped), TRUST), /INVALID_SNAPSHOT_TX_SENDER/);
  // A note whose owner is a legacy H(secret, salt) id.
  const legacy = structuredClone(snap) as any;
  legacy.notes.push(serializeNote(makeNote(hAccount(a.secret, a.salt), asset, 5n, new Fr(77n))));
  assert.throws(() => UepLedger.restore(resign(legacy), TRUST, NODE_KEYS), /INVALID_SNAPSHOT_NOTE_OWNER/);
});
