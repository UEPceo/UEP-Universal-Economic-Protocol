/**
 * v0.4.4: authenticated, bounded pending queue (UEP-B06/A06, D01), note-commitment
 * tree membership (spends and restore) and the protocol fee floor (UEP-A16).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Fr } from "../core/field.ts";
import { encodeStringToFr } from "../core/encoding.ts";
import { creatorFee, MIN_PROTOCOL_FEE } from "../core/fee.ts";
import { makeNote, serializeNote, deserializeNote } from "../core/note.ts";
import { computeTxCommitment, txIdFromCommitment, serializeTx, type UepTransaction } from "../core/transaction.ts";
import { verifyNoteMembership } from "../core/note-tree.ts";
import { signSenderAuth } from "../core/spend-key.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";
import { UepLedger, signSnapshot, type UepLedgerSnapshot } from "./ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";

const SNAPSHOT_KEY = generateEd25519KeyPair();
const FAUCET_KEY = generateEd25519KeyPair();
const TRUST = { authorities: [SNAPSHOT_KEY.publicKeyHex], faucetPublicKeys: [FAUCET_KEY.publicKeyHex] };
const NODE_KEYS = { snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey };
const EUR = "uep-test/teur";
const asset = encodeStringToFr(EUR);

const identity = async () => identityFromMnemonic(await generateMnemonic(128));
const ledger = (extra: { maxPendingTransactions?: number; testOnlyDisableProof?: boolean } = {}) =>
  new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey, ...extra });
const resign = (snap: UepLedgerSnapshot) => signSnapshot(snap, [SNAPSHOT_KEY.privateKey]);
const code = (r: { error: { code: string } } | { tx: unknown }) => ("error" in r ? r.error.code : "OK");
function prepared(l: UepLedger, from: IdentitySecrets, to: Fr, amount: bigint): UepTransaction {
  const p = l.prepareSpend(from, to, EUR, amount);
  assert.ok("tx" in p, "error" in p ? p.error.message : "");
  return (p as { tx: UepTransaction }).tx;
}
/** A receiving node restored from the source's signed snapshot (v0.4.5: no spend-key registry needed). */
function replicaOf(source: UepLedger, extra: { connected?: boolean; maxPendingTransactions?: number } = {}): UepLedger {
  const snap = structuredClone(source.snapshotPayload()) as any;
  if (extra.connected !== undefined) snap.connected = extra.connected;
  if (extra.maxPendingTransactions !== undefined) snap.maxPendingTransactions = extra.maxPendingTransactions;
  return UepLedger.restore(signSnapshot(snap, [SNAPSHOT_KEY.privateKey]), TRUST, NODE_KEYS);
}
/** Rebuild a spend with different outputs, correctly re-signed by the (dishonest) sender. */
function rebuilt(base: UepTransaction, secrets: IdentitySecrets, outputs: ReturnType<typeof makeNote>[]): UepTransaction {
  const outputCommitments = outputs.map((o) => o.commitment);
  const transactionCommitment = computeTxCommitment({ networkId: base.networkId, domainId: base.domainId, senderId: base.senderId, recipientId: base.recipientId, assetId: base.assetId, amount: base.amount, fee: base.fee, nonce: base.nonce, nullifier: base.nullifier, inputCommitments: base.inputCommitments, outputCommitments });
  const txId = txIdFromCommitment(transactionCommitment, base.nullifier);
  return { ...base, outputCommitments, outputNotes: outputs.map(serializeNote), transactionCommitment, txId, senderAuth: signSenderAuth({ ...base, txId, transactionCommitment }, secrets.secret, secrets.salt) };
}

// ---------------------------------------------------------------- pending queue

test("pending: an unsigned spend or one signed by another key is refused", async () => {
  const a = await identity(); const b = await identity(); const z = await identity();
  const source = ledger();
  source.faucet(a.accountId, EUR, 1_000n);
  source.faucet(z.accountId, EUR, 1_000n);
  const l = replicaOf(source);
  const tx = prepared(source, a, b.accountId, 100n);
  const { senderAuth: _drop, ...unsigned } = tx;
  assert.equal(code(l.queueConflict(unsigned as UepTransaction)), "SENDER_AUTH");
  // Signed by z's spend key instead of the sender's: z's key does not hash to a's account.
  const wrongKey = { ...tx, senderAuth: signSenderAuth(tx, z.secret, z.salt) };
  assert.equal(code(l.queueConflict(wrongKey)), "OWNER_KEY");
  // A signature over a different transaction does not transfer.
  const other = prepared(source, a, z.accountId, 50n);
  assert.equal(code(l.queueConflict({ ...tx, senderAuth: other.senderAuth })), "SENDER_AUTH");
  assert.equal(l.pending.length, 0);
  assert.equal(code(l.queueConflict(tx)), "OK");
});

test("pending: a replica authenticates a first-time sender from its key-derived account alone", async () => {
  const a = await identity(); const b = await identity();
  const source = ledger();
  source.faucet(a.accountId, EUR, 1_000n);
  const l = replicaOf(source); // snapshot taken before a ever spent: no key was ever shared
  assert.equal((l as unknown as { registerSpendKey?: unknown }).registerSpendKey, undefined);
  assert.equal((l.snapshotPayload() as Record<string, unknown>).spendKeys, undefined);
  const tx = prepared(source, a, b.accountId, 100n);
  assert.equal(tx.senderAuth!.publicKey, a.spendPublicKey);
  assert.equal(code(l.queueConflict(tx)), "OK");
});

test("pending: inputs must be canonical unspent notes of this ledger, under the spend-shape rules", async () => {
  const a = await identity(); const b = await identity(); const z = await identity();
  const source = ledger();
  source.faucet(a.accountId, EUR, 1_000n);
  const l = replicaOf(source);
  // Input note that only exists on another ledger.
  const elsewhere = ledger();
  elsewhere.faucet(a.accountId, EUR, 5_000n);
  assert.equal(code(l.queueConflict(prepared(elsewhere, a, b.accountId, 100n))), "NOTE_NOT_MEMBER");
  // Transported opening that disagrees with the ledger's canonical note.
  const tx = prepared(source, a, b.accountId, 100n);
  const forgedOpening = { ...tx, inputNotes: tx.inputNotes!.map((n) => ({ ...n, amount: "999999" })) };
  assert.equal(code(l.queueConflict(forgedOpening)), "NOTE_OPENING");
  // Authenticated sender redirecting value: outputs violate the spend shape.
  const outs = tx.outputNotes!.map(deserializeNote);
  const redirected = rebuilt(tx, a, [makeNote(z.accountId, asset, 100n, outs[0]!.blinding), outs[1]!]);
  assert.equal(code(l.queueConflict(redirected)), "OUTPUT_BINDING");
  // Once the note is spent on this ledger, a queued spend of it is refused.
  assert.ok("tx" in l.submit(prepared(l, a, z.accountId, 10n), a));
  assert.ok(["DOUBLE_SPEND", "REPLAY"].includes(code(l.queueConflict(tx))));
  assert.equal(l.pending.length, 0);
});

test("pending: the queue is bounded and the bound is configurable", async () => {
  const a = await identity(); const b = await identity();
  assert.throws(() => ledger({ maxPendingTransactions: 0 }), /INVALID_MAX_PENDING_TRANSACTIONS/);
  assert.throws(() => ledger({ maxPendingTransactions: 1.5 }), /INVALID_MAX_PENDING_TRANSACTIONS/);
  assert.equal(ledger().maxPendingTransactions, 1024);
  const source = ledger();
  for (const v of [200n, 2_000n, 20_000n]) source.faucet(a.accountId, EUR, v);
  const l = replicaOf(source, { maxPendingTransactions: 2 });
  assert.equal(l.maxPendingTransactions, 2);
  // Three valid spends of three distinct notes, all anchored at the shared note root.
  const txs = [150n, 1_500n, 15_000n].map((v) => prepared(source, a, b.accountId, v));
  assert.equal(new Set(txs.map((t) => t.inputCommitments[0]!.toHex())).size, 3);
  assert.equal(code(l.queueConflict(txs[0]!)), "OK");
  assert.equal(code(l.queueConflict(txs[1]!)), "OK");
  assert.equal(code(l.queueConflict(txs[2]!)), "PENDING_FULL");
  assert.equal(l.pending.length, 2);
});

test("pending: offline submit validates before queueing", async () => {
  const a = await identity(); const b = await identity();
  const source = ledger();
  source.faucet(a.accountId, EUR, 1_000n);
  const offline = replicaOf(source, { connected: false });
  assert.equal(offline.connected, false);
  const tx = prepared(source, a, b.accountId, 100n);
  const { senderAuth: _drop, ...unsigned } = tx;
  assert.equal(code(offline.submit(unsigned as UepTransaction)), "SENDER_AUTH");
  assert.equal(offline.pending.length, 0);
  const queued = offline.submit(tx);
  assert.equal(code(queued), "NOT_CONNECTED");
  assert.match((queued as { error: { message: string } }).error.message, /queued/);
  assert.equal(offline.pending.length, 1);
  assert.equal(offline.pending[0]!.phase, "LOCAL_VALID");
  assert.equal(offline.txs.length, 0);
});

test("pending: reconcile flags spends sharing an input note and never settles them", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  const t1 = prepared(l, a, b.accountId, 100n);
  const t2 = prepared(l, a, b.accountId, 300n);
  assert.equal(code(l.queueConflict(t1)), "OK");
  assert.equal(code(l.queueConflict(t2)), "OK");
  const r = l.reconcilePending();
  assert.equal(r.queued.length, 2);
  assert.ok(r.queued.every((t) => t.inConflict && t.phase === "LOCAL_VALID"));
  assert.equal(r.settlements.length, 0);
  assert.equal(l.balanceOf(b.accountId, asset), 0n);
});

test("restore: a poisoned or oversized pending queue is rejected; stale entries are not exported", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  l.faucet(a.accountId, EUR, 1_000n);
  const t1 = prepared(l, a, b.accountId, 100n);
  assert.equal(code(l.queueConflict(t1)), "OK");
  const honest = l.snapshot();
  assert.equal(UepLedger.restore(structuredClone(honest), TRUST).pending.length, 1);

  // Unsigned pending entry injected by a snapshot-key holder.
  const unsigned = structuredClone(honest) as any;
  delete unsigned.pending[0].senderAuth;
  assert.throws(() => UepLedger.restore(resign(unsigned), TRUST), /INVALID_SNAPSHOT_PENDING: SENDER_AUTH/);
  // Pending entry whose input is not a ledger note.
  const elsewhere = ledger();
  elsewhere.faucet(a.accountId, EUR, 7_000n);
  const foreign = structuredClone(honest) as any;
  foreign.pending.push(serializeTx(prepared(elsewhere, a, b.accountId, 10n)));
  assert.throws(() => UepLedger.restore(resign(foreign), TRUST), /INVALID_SNAPSHOT_PENDING: NOTE_NOT_MEMBER/);
  // Duplicate and over-bound queues.
  const dup = structuredClone(honest) as any;
  dup.pending.push(dup.pending[0]);
  assert.throws(() => UepLedger.restore(resign(dup), TRUST), /INVALID_SNAPSHOT_PENDING: duplicate/);
  const t2 = prepared(l, a, b.accountId, 200n);
  l.pending.push({ ...t2 }); // bypass enqueue to build an over-bound snapshot (2 entries)
  const over = structuredClone(l.snapshotPayload()) as any;
  over.maxPendingTransactions = 1;
  assert.throws(() => UepLedger.restore(resign(over), TRUST), /INVALID_SNAPSHOT_PENDING: pending queue exceeds/);
  l.pending.pop();

  // A pending spend whose input was spent meanwhile is dropped from the next snapshot.
  assert.ok("tx" in l.submit(t1, a));
  const after = l.snapshot();
  assert.equal(after.pending.length, 0);
  assert.ok(UepLedger.restore(after, TRUST));
});

// ---------------------------------------------------------------- note-commitment tree

test("note tree: spends carry a membership proof that a replica can check against the root", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  const empty = l.noteCommitmentRoot().toHex();
  const note = l.faucet(a.accountId, EUR, 1_000n);
  const afterMint = l.noteCommitmentRoot().toHex();
  assert.notEqual(empty, afterMint);
  const tx = prepared(l, a, b.accountId, 100n);
  assert.equal(tx.inputMembership!.length, 1);
  const proof = tx.inputMembership![0]!;
  assert.equal(proof.root, afterMint);
  assert.equal(proof.leafIndex, "0");
  // Stateless check: commitment + proof + a trusted root (e.g. from a signed snapshot).
  assert.ok(verifyNoteMembership(note.commitment, proof));
  assert.ok(!verifyNoteMembership(tx.outputCommitments[0]!, proof));
  assert.ok("tx" in l.submit(tx, a));
  assert.equal(l.noteTree.size, 1 + tx.outputCommitments.length);
  assert.notEqual(l.noteCommitmentRoot().toHex(), afterMint);
  const snap = l.snapshot();
  assert.equal(snap.noteRoot, l.noteCommitmentRoot().toHex());
  assert.equal(snap.noteCount, l.noteTree.size);
  assert.equal(UepLedger.restore(snap, TRUST).noteCommitmentRoot().toHex(), snap.noteRoot);
});

test("note tree: a missing, forged or unanchored membership proof is rejected by submit", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  const tx = prepared(l, a, b.accountId, 100n);
  const { inputMembership: _drop, ...noProof } = tx;
  assert.equal(code(l.submit(noProof as UepTransaction, a)), "MEMBERSHIP_PROOF");
  const p = tx.inputMembership![0]!;
  const forged = { ...tx, inputMembership: [{ ...p, siblings: p.siblings.map((s, i) => (i === 0 ? "01".padStart(64, "0") : s)) }] };
  assert.equal(code(l.submit(forged, a)), "MEMBERSHIP_PROOF");
  const wrongIndex = { ...tx, inputMembership: [{ ...p, leafIndex: "1" }] };
  assert.equal(code(l.submit(wrongIndex, a)), "MEMBERSHIP_PROOF");
  // A proof valid under a root this ledger never had (another ledger's tree).
  const other = ledger();
  other.faucet(b.accountId, EUR, 5n);
  other.faucet(a.accountId, EUR, 1_000n);
  const foreignProof = { ...tx, inputMembership: [{ ...p, root: other.noteCommitmentRoot().toHex() }] };
  assert.equal(code(l.submit(foreignProof, a)), "MEMBERSHIP_PROOF");
  assert.equal(l.txs.length, 0);
  assert.equal(code(l.submit(tx, a)), "OK");
});

test("note tree: restore checks the signed root and every committed spend's membership proof", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  assert.ok("tx" in l.submit(prepared(l, a, b.accountId, 100n), a));
  const snap = l.snapshot();
  const badRoot = structuredClone(snap) as any;
  badRoot.noteRoot = "0".repeat(63) + "1";
  assert.throws(() => UepLedger.restore(resign(badRoot), TRUST), /INVALID_SNAPSHOT_NOTE_ROOT/);
  const badCount = structuredClone(snap) as any;
  badCount.noteCount += 1;
  assert.throws(() => UepLedger.restore(resign(badCount), TRUST), /INVALID_SNAPSHOT_NOTE_ROOT/);
  const reordered = structuredClone(snap) as any;
  reordered.notes.reverse();
  assert.throws(() => UepLedger.restore(resign(reordered), TRUST), /INVALID_SNAPSHOT_(NOTE_ROOT|TX_MEMBERSHIP)/);
  const noProof = structuredClone(snap) as any;
  delete noProof.txs[0].inputMembership;
  assert.throws(() => UepLedger.restore(resign(noProof), TRUST), /INVALID_SNAPSHOT_TX_MEMBERSHIP/);
  const unsignedTx = structuredClone(snap) as any;
  delete unsignedTx.txs[0].senderAuth;
  assert.throws(() => UepLedger.restore(resign(unsignedTx), TRUST), /INVALID_SNAPSHOT_TX_SENDER/);
  for (const v of [3, 4, 5, 6]) {
    const old = structuredClone(snap) as any;
    old.formatVersion = v;
    assert.throws(() => UepLedger.restore(resign(old), TRUST), new RegExp(`INVALID_SNAPSHOT_VERSION: snapshot formatVersion ${v} is no longer supported`));
  }
});

test("submit: the sender signature is required, also when requireProof is disabled", async () => {
  const a = await identity(); const b = await identity();
  // v0.4.7: requireProof is fixed at construction; only the test-only flag disables it.
  assert.throws(() => { ledger().requireProof = false; }, /REQUIRE_PROOF_IMMUTABLE/);
  const l = ledger({ testOnlyDisableProof: true });
  assert.equal(l.requireProof, false);
  l.faucet(a.accountId, EUR, 1_000n);
  const tx = prepared(l, a, b.accountId, 100n);
  const { senderAuth: _drop, ...unsigned } = tx;
  assert.equal(code(l.submit(unsigned as UepTransaction, a)), "SENDER_AUTH");
  assert.equal(code(l.submit(unsigned as UepTransaction)), "SENDER_AUTH");
  assert.equal(l.txs.length, 0);
  assert.equal(code(l.submit(tx)), "OK");
});

// ---------------------------------------------------------------- protocol fee floor (UEP-A16)

test("fee: the 0.1% protocol fee has a 1-unit floor and stays 0.1% above 1000 units", async () => {
  assert.equal(MIN_PROTOCOL_FEE, 1n);
  assert.equal(creatorFee(0n), 0n);
  assert.equal(creatorFee(1n), 1n);
  assert.equal(creatorFee(999n), 1n);
  assert.equal(creatorFee(1_000n), 1n);
  assert.equal(creatorFee(1_999n), 1n);
  assert.equal(creatorFee(2_000n), 2n);
  assert.equal(creatorFee(100_000n), 100n);
  const a = await identity(); const b = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 10n);
  const tx = prepared(l, a, b.accountId, 5n);
  assert.equal(tx.fee, 1n);
  assert.ok("tx" in l.submit(tx, a));
  // Conservation: 10 = 5 (recipient) + 4 (change) + 1 (treasury).
  assert.equal(l.balanceOf(b.accountId, asset), 5n);
  assert.equal(l.balanceOf(a.accountId, asset), 4n);
  assert.equal(l.balanceOf(TREASURY_ID, asset), 1n);
  // Many tiny spends can no longer avoid the fee.
  const tiny = prepared(l, a, b.accountId, 1n);
  assert.equal(tiny.fee, 1n);
  // A zero-fee envelope is refused.
  const zeroFee = { ...tiny, fee: 0n };
  assert.notEqual(code(l.submit(zeroFee, a)), "OK");
  assert.ok(UepLedger.restore(l.snapshot(), TRUST));
});
