/**
 * v0.5.3 UEP-C04: multi-input transactions. A spend may consume 2..8 notes
 * with a nullifier (and nonce) vector, pays ONE protocol fee and returns at
 * most one change note (consolidation). Single-input transactions keep the
 * v0.5.2 form (version 1, no vectors, same commitment / txId rules).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "./ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";
import { encodeStringToFr } from "../core/encoding.ts";
import { creatorFee } from "../core/fee.ts";
import { MAX_TX_INPUTS, deserializeTx, serializeTx, txCommitmentOf, txIdFromCommitment, txNullifiers, type UepTransaction } from "../core/transaction.ts";
import { signSenderAuth } from "../core/spend-key.ts";
import { Fr } from "../core/field.ts";

const SNAP = generateEd25519KeyPair();
const FAUCET = generateEd25519KeyPair();
const TRUST = { authorities: [SNAP.publicKeyHex], faucetPublicKeys: [FAUCET.publicKeyHex] };
const EUR = "uep-test/teur";
const asset = encodeStringToFr(EUR);
const ledger = () => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey });
const identity = async () => identityFromMnemonic(await generateMnemonic(128));
const code = (r: { error: { code: string } } | { tx: unknown }) => ("error" in r ? r.error.code : "OK");

async function setup(notes: bigint[]) {
  const l = ledger();
  const a = await identity();
  const b = await identity();
  for (const n of notes) l.faucet(a.accountId, EUR, n);
  return { l, a, b };
}

function resigned(tx: UepTransaction, secrets: { secret: Fr; salt: Fr }): UepTransaction {
  const transactionCommitment = txCommitmentOf(tx);
  const t = { ...tx, transactionCommitment, txId: txIdFromCommitment(transactionCommitment, tx.nullifier) };
  return { ...t, senderAuth: signSenderAuth(t, secrets.secret, secrets.salt) };
}

test("C04: three notes pay one amount with one fee and one change note", async () => {
  const { l, a, b } = await setup([400n, 400n, 400n]);
  assert.equal(code(l.prepareSpend(a, b.accountId, EUR, 1_000n)), "INSUFFICIENT");
  const p = l.prepareMultiInputSpend(a, b.accountId, EUR, 1_000n);
  assert.ok("tx" in p, "error" in p ? p.error.message : "");
  const tx = p.tx;
  assert.equal(tx.version, 2);
  assert.equal(tx.inputCommitments.length, 3);
  assert.equal(txNullifiers(tx).length, 3);
  const fee = creatorFee(1_000n, l.feeFloorOf(asset));
  assert.equal(tx.fee, fee);
  assert.equal(tx.outputCommitments.length, 2);
  const treasuryBefore = l.balanceOf(TREASURY_ID, asset);
  const r = l.submit(tx);
  assert.ok("tx" in r, "error" in r ? r.error.message : "");
  assert.equal(l.balanceOf(b.accountId, asset), 1_000n);
  assert.equal(l.balanceOf(a.accountId, asset), 1_200n - 1_000n - fee);
  assert.equal(l.balanceOf(TREASURY_ID, asset) - treasuryBefore, fee);
  assert.match(code(l.submit(tx)), /REPLAY|DOUBLE_SPEND/);
});

test("C04: a single covering note stays a v0.5.2 single-input transaction", async () => {
  const { l, a, b } = await setup([5_000n, 100n]);
  const p = l.prepareMultiInputSpend(a, b.accountId, EUR, 1_000n);
  assert.ok("tx" in p);
  assert.equal(p.tx.version, 1);
  assert.equal(p.tx.inputNullifiers, undefined);
  assert.equal(p.tx.inputCommitments.length, 1);
  assert.equal(code(l.submit(p.tx)), "OK");
});

test("C04: tampered vectors are refused (dropped, reordered, forged, duplicated, version)", async () => {
  const { l, a, b } = await setup([300n, 300n, 300n]);
  const p = l.prepareMultiInputSpend(a, b.accountId, EUR, 800n);
  assert.ok("tx" in p);
  const tx = p.tx;
  // Reordered vector without re-signing: commitment mismatch.
  const reordered = { ...tx, inputNullifiers: [tx.inputNullifiers![0]!, tx.inputNullifiers![2]!, tx.inputNullifiers![1]!] };
  assert.equal(code(l.submit(reordered)), "AMOUNT_MISMATCH");
  // Dropped nullifier, even re-signed by the owner: one nullifier per input.
  assert.equal(code(l.submit(resigned({ ...tx, inputNullifiers: tx.inputNullifiers!.slice(0, 2), inputNonces: tx.inputNonces!.slice(0, 2) }, a))), "AMOUNT_MISMATCH");
  // Forged nullifier for input 2, re-signed by the owner: not the sender-bound nullifier.
  const forged = resigned({ ...tx, inputNullifiers: [...tx.inputNullifiers!.slice(0, 2), new Fr(12345n)] }, a);
  assert.equal(code(l.submit(forged)), "WRONG_OWNER");
  // Duplicated nullifier.
  assert.equal(code(l.submit(resigned({ ...tx, inputNullifiers: [tx.inputNullifiers![0]!, tx.inputNullifiers![0]!, tx.inputNullifiers![2]!] }, a))), "AMOUNT_MISMATCH");
  // Version 1 with vectors / version 2 without.
  assert.equal(code(l.submit(resigned({ ...tx, version: 1 }, a))), "AMOUNT_MISMATCH");
  const { inputNullifiers: _n, inputNonces: _o, ...bare } = tx;
  assert.equal(code(l.submit(resigned(bare as UepTransaction, a))), "AMOUNT_MISMATCH");
  // Nonce vector not bound to the notes.
  assert.match(code(l.submit(resigned({ ...tx, inputNonces: [tx.inputNonces![0]!, tx.inputNonces![2]!, tx.inputNonces![1]!] }, a))), /WRONG_OWNER|NOTE_NONCE/);
  // The honest one still goes through.
  assert.equal(code(l.submit(tx)), "OK");
});

test("C04: a note already spent by a single-input tx cannot be spent again inside a multi-input tx", async () => {
  const { l, a, b } = await setup([600n, 600n]);
  const multi = l.prepareMultiInputSpend(a, b.accountId, EUR, 1_100n);
  assert.ok("tx" in multi && multi.tx.inputCommitments.length === 2);
  const single = l.prepareSpend(a, b.accountId, EUR, 100n);
  assert.ok("tx" in single);
  assert.equal(code(l.submit(single.tx)), "OK");
  assert.equal(code(l.submit(multi.tx)), "DOUBLE_SPEND");
});

test("C04: at most MAX_TX_INPUTS notes per transaction", async () => {
  const { l, a, b } = await setup(Array.from({ length: MAX_TX_INPUTS + 1 }, () => 100n));
  assert.equal(code(l.prepareMultiInputSpend(a, b.accountId, EUR, 850n)), "INSUFFICIENT");
  const ok = l.prepareMultiInputSpend(a, b.accountId, EUR, 700n);
  assert.ok("tx" in ok);
  assert.equal(ok.tx.inputCommitments.length, MAX_TX_INPUTS);
  assert.equal(code(l.submit(ok.tx)), "OK");
});

test("C04: multi-input history survives snapshot / restore and the wire format", async () => {
  const { l, a, b } = await setup([250n, 250n, 250n, 1_200n]);
  const s1 = l.prepareSpend(a, b.accountId, EUR, 1_000n);
  assert.ok("tx" in s1);
  assert.equal(code(l.submit(s1.tx)), "OK");
  const p = l.prepareMultiInputSpend(a, b.accountId, EUR, 800n);
  assert.ok("tx" in p);
  assert.equal(p.tx.inputCommitments.length, 4);
  const wire = deserializeTx(JSON.parse(JSON.stringify(serializeTx(p.tx))));
  assert.deepEqual(wire.inputNullifiers!.map((x) => x.toHex()), p.tx.inputNullifiers!.map((x) => x.toHex()));
  assert.equal(code(l.submit(wire)), "OK");
  const restored = UepLedger.restore(l.snapshot(), TRUST);
  assert.ok(restored.nullifierRoot().eq(l.nullifierRoot()));
  assert.equal(restored.balanceOf(b.accountId, asset), 1_800n);
  // Every nullifier of the multi-input tx is spent on the replica too.
  assert.match(code(restored.submit(wire)), /REPLAY|DOUBLE_SPEND/);
});

test("C04: reconciliation settles at most one spend per nullifier with multi-input spends, order independent", async () => {
  const { reconcile } = await import("../core/reconciliation.ts");
  const mk = (id: bigint, nfs: bigint[]) => ({ txId: new Fr(id), nullifier: new Fr(nfs[0]!), ...(nfs.length > 1 ? { inputNullifiers: nfs.map((x) => new Fr(x)) } : {}), fee: 1n }) as unknown as UepTransaction;
  const A = mk(1n, [10n, 20n]); // multi-input
  const B = mk(2n, [20n]); // conflicts with A on 20
  const C = mk(3n, [30n, 10n]); // conflicts with A on 10
  const D = mk(4n, [40n]); // independent
  const status = (txs: UepTransaction[]) => Object.fromEntries(reconcile(txs).map((s) => [s.txId.n.toString(), s.status]));
  const want = { "1": "SETTLED", "2": "INVALIDATED", "3": "INVALIDATED", "4": "SETTLED" };
  assert.deepEqual(status([A, B, C, D]), want);
  assert.deepEqual(status([D, C, B, A]), want);
  // Without A, B and C no longer conflict with each other.
  assert.deepEqual(status([C, B]), { "2": "SETTLED", "3": "SETTLED" });
});
