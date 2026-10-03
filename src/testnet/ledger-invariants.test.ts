/**
 * v0.4.2 ledger invariants: output binding (UEP-B03), restore availability
 * (UEP-B02), snapshot invariants under a valid authority tag (UEP-B05),
 * nonce/note binding (UEP-C01) and distinct transfer participants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Fr } from "../core/field.ts";
import { hLeaf } from "../core/hash.ts";
import { encodeStringToFr, u64ToFr } from "../core/encoding.ts";
import { deriveNullifier, signedSpendNullifier } from "../core/nullifier.ts";
import { deserializeNote, makeNote, serializeNote, type Note } from "../core/note.ts";
import { computeTxCommitment, txIdFromCommitment, type UepTransaction } from "../core/transaction.ts";
import { DevelopmentSpendProofProvider } from "../core/spend-proof.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";
import { UepLedger, signSnapshot, type UepLedgerSnapshot } from "./ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { signSenderAuth } from "../core/spend-key.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";

const SNAPSHOT_KEY = generateEd25519KeyPair();
const FAUCET_KEY = generateEd25519KeyPair();
const AUTH = { authorities: [SNAPSHOT_KEY.publicKeyHex], faucetPublicKeys: [FAUCET_KEY.publicKeyHex] };
const EUR = "uep-test/teur";
const asset = encodeStringToFr(EUR);

const newLedger = () => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey });
const identity = async () => identityFromMnemonic(await generateMnemonic(128));

function resign(snap: UepLedgerSnapshot): UepLedgerSnapshot {
  return signSnapshot(snap, [SNAPSHOT_KEY.privateKey]);
}

/** Re-authorize a modified spend with the sender's own secrets (an authenticated but dishonest sender). */
function reauthorize(l: UepLedger, secrets: IdentitySecrets, base: UepTransaction, change: { inputs?: Note[]; outputs?: Note[]; nonce?: Fr; recipientId?: Fr }): UepTransaction {
  const inputs = change.inputs ?? base.inputNotes!.map(deserializeNote);
  const outputs = change.outputs ?? base.outputNotes!.map(deserializeNote);
  const nonce = change.nonce ?? base.nonce;
  const recipientId = change.recipientId ?? base.recipientId;
  // Keep the authorization scheme of `base` (v0.5.0 default: sender-signature).
  const signed = base.spendProof.kind === "sender-signature";
  const nullifier = signed ? signedSpendNullifier(base.senderId, nonce) : deriveNullifier(secrets.secret, nonce);
  const inputCommitments = inputs.map((n) => n.commitment);
  const outputCommitments = outputs.map((n) => n.commitment);
  const transactionCommitment = computeTxCommitment({ networkId: base.networkId, domainId: base.domainId, senderId: base.senderId, recipientId, assetId: base.assetId, amount: base.amount, fee: base.fee, nonce, nullifier, inputCommitments, outputCommitments });
  const spendProof = signed ? { ...base.spendProof } : DevelopmentSpendProofProvider.prove({
    oldStateRoot: l.stateRoot(), newStateRoot: l.stateRoot(), oldNullifierRoot: l.nullifierRoot(), newNullifierRoot: l.nullifierRoot(),
    senderId: base.senderId, recipientId, treasuryId: TREASURY_ID, assetId: base.assetId, nullifier,
    amount: u64ToFr(base.amount), fee: u64ToFr(base.fee), transactionCommitment,
  }, { senderSecret: secrets.secret, senderSalt: secrets.salt, nonce });
  const txId = txIdFromCommitment(transactionCommitment, nullifier);
  return {
    ...base, recipientId, nonce, nullifier, inputCommitments, outputCommitments,
    inputNotes: inputs.map(serializeNote), outputNotes: outputs.map(serializeNote),
    transactionCommitment, txId, spendProof,
    // v0.4.4: re-sign the sender envelope and re-prove membership, so each test hits the rule it targets.
    senderAuth: signSenderAuth({ networkId: base.networkId, domainId: base.domainId, txId, senderId: base.senderId, transactionCommitment }, secrets.secret, secrets.salt),
    inputMembership: inputs.map((n, i) => (l.noteTree.indexOf(n.commitment) !== undefined ? l.noteTree.prove(n.commitment) : base.inputMembership![i] ?? base.inputMembership![0]!)),
  };
}

function prepared(l: UepLedger, from: IdentitySecrets, to: Fr, amount: bigint): UepTransaction {
  const p = l.prepareSpend(from, to, EUR, amount);
  assert.ok("tx" in p, "error" in p ? p.error.code : "");
  return (p as { tx: UepTransaction }).tx;
}

function errorCode(r: ReturnType<UepLedger["submit"]>): string | undefined {
  return "error" in r ? r.error.code : undefined;
}

test("B03: outputs redirected to a third party are rejected and the honest snapshot still restores (B02)", async () => {
  const [a, b, z] = await Promise.all([identity(), identity(), identity()]);
  const l = newLedger();
  l.faucet(a.accountId, EUR, 10_000n);
  const tx = prepared(l, a, b.accountId, 1_000n);
  const outs = tx.outputNotes!.map(deserializeNote);
  const redirected = reauthorize(l, a, tx, { outputs: [makeNote(z.accountId, asset, 1_000n, outs[0]!.blinding), outs[1]!] });
  const rootBefore = l.stateRoot().toHex();
  assert.equal(errorCode(l.submit(redirected, a)), "OUTPUT_BINDING");
  assert.equal(l.stateRoot().toHex(), rootBefore);
  assert.equal(l.txs.length, 0);
  assert.ok(UepLedger.restore(l.snapshot(), AUTH));
  // The honest spend of the same note still works and its snapshot restores.
  assert.ok("tx" in l.submit(tx, a));
  const restored = UepLedger.restore(l.snapshot(), AUTH);
  assert.equal(restored.balanceOf(b.accountId, asset), 1_000n);
  assert.equal(restored.notesOf(b.accountId).length, 1);
});

test("B03: recipient amount and change are bound exactly", async () => {
  const [a, b] = await Promise.all([identity(), identity()]);
  const l = newLedger();
  l.faucet(a.accountId, EUR, 10_000n);
  const tx = prepared(l, a, b.accountId, 2_000n);
  const [out, change] = tx.outputNotes!.map(deserializeNote) as [Note, Note];
  const cases: Note[][] = [
    [makeNote(b.accountId, asset, 1_000n, out.blinding), makeNote(a.accountId, asset, change.amount + 1_000n, change.blinding)], // recipient underpaid
    [makeNote(b.accountId, asset, 3_000n, out.blinding), makeNote(a.accountId, asset, change.amount - 1_000n, change.blinding)], // recipient overpaid
    [makeNote(b.accountId, asset, 2_000n, out.blinding), makeNote(b.accountId, asset, change.amount, change.blinding)], // change to recipient
    [change, out], // swapped order
    [out], // change dropped
  ];
  for (const outputs of cases) assert.equal(errorCode(l.submit(reauthorize(l, a, tx, { outputs }), a)), "OUTPUT_BINDING");
  assert.equal(l.txs.length, 0);
  assert.ok("tx" in l.submit(tx, a));
});

test("C01: transaction nonce must be the consumed note's nonce", async () => {
  const [a, b] = await Promise.all([identity(), identity()]);
  const l = newLedger();
  l.faucet(a.accountId, EUR, 10_000n);
  const tx = prepared(l, a, b.accountId, 1_000n);
  const unbound = reauthorize(l, a, tx, { nonce: hLeaf(tx.nonce, new Fr(7n)) });
  assert.equal(errorCode(l.submit(unbound, a)), "NOTE_NONCE");
  assert.ok("tx" in l.submit(tx, a));
});

test("B01: an input commitment that is not in the ledger is rejected", async () => {
  const [a, b] = await Promise.all([identity(), identity()]);
  const l = newLedger();
  l.faucet(a.accountId, EUR, 10_000n);
  const tx = prepared(l, a, b.accountId, 1_000n);
  const outsider = makeNote(a.accountId, asset, 10_000n, hLeaf(a.secret, new Fr(999_999n)));
  const forged = reauthorize(l, a, tx, { inputs: [outsider], nonce: outsider.nonce });
  assert.equal(errorCode(l.submit(forged, a)), "NOTE_NOT_MEMBER");
});

test("self-transfers and treasury-party transfers are rejected", async () => {
  const [a, b] = await Promise.all([identity(), identity()]);
  const l = newLedger();
  l.faucet(a.accountId, EUR, 10_000n);
  for (const to of [a.accountId, TREASURY_ID]) {
    const p = l.prepareSpend(a, to, EUR, 1_000n);
    assert.ok("error" in p && p.error.code === "INVALID_PARTICIPANTS");
  }
  const tx = prepared(l, a, b.accountId, 1_000n);
  const outs = tx.outputNotes!.map(deserializeNote);
  const self = reauthorize(l, a, tx, { recipientId: a.accountId, outputs: [makeNote(a.accountId, asset, 1_000n, outs[0]!.blinding), outs[1]!] });
  assert.equal(errorCode(l.submit(self, a)), "INVALID_PARTICIPANTS");
  assert.equal(l.balanceOf(a.accountId, asset), 10_000n);
});

test("B02: honest snapshots restore after many random honest spends", async () => {
  const people = await Promise.all([identity(), identity(), identity(), identity()]);
  const l = newLedger();
  for (const p of people) l.faucet(p.accountId, EUR, 50_000n);
  l.faucet(people[0]!.accountId, EUR, 1_001n);
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  let applied = 0;
  for (let i = 0; i < 24; i++) {
    const from = people[rnd(4)]!; let to = people[rnd(4)]!;
    if (to === from) to = people[(people.indexOf(from) + 1) % 4]!;
    const amount = BigInt(1 + rnd(9_000));
    const p = l.prepareSpend(from, to.accountId, EUR, amount);
    if ("error" in p) { assert.equal(p.error.code, "INSUFFICIENT"); continue; }
    assert.ok("tx" in l.submit(p.tx, from));
    applied++;
    if (i % 6 === 0) assert.ok(UepLedger.restore(l.snapshot(), AUTH));
  }
  assert.ok(applied > 10);
  const restored = UepLedger.restore(structuredClone(l.snapshot()), AUTH);
  assert.equal(restored.stateRoot().toHex(), l.stateRoot().toHex());
  assert.equal(restored.nullifierRoot().toHex(), l.nullifierRoot().toHex());
  for (const p of people) assert.equal(restored.balanceOf(p.accountId, asset), l.balanceOf(p.accountId, asset));
  const total = [...people.map((p) => p.accountId), TREASURY_ID].reduce((s, id) => s + l.balanceOf(id, asset), 0n);
  assert.equal(total, 201_001n);
});

async function ledgerWithHistory() {
  const [a, b] = await Promise.all([identity(), identity()]);
  const l = newLedger();
  l.faucet(a.accountId, EUR, 10_000n);
  l.faucet(b.accountId, EUR, 5_000n);
  assert.ok("tx" in l.submit(prepared(l, a, b.accountId, 2_000n), a));
  return { l, a, b };
}

test("B05: restore rejects authority-signed snapshots that break internal invariants", async () => {
  // Balance inflated together with a consistent state root (no matching note).
  {
    const { l, a } = await ledgerWithHistory();
    (l as any).setBalance(a.accountId, asset, l.balanceOf(a.accountId, asset) + 1_000_000n);
    assert.throws(() => UepLedger.restore(l.snapshot(), AUTH), /INVALID_SNAPSHOT_NOTE_BALANCE/);
  }
  // Value created outside the faucet: note + balance without a signed mint record.
  {
    const { l, a } = await ledgerWithHistory();
    l.notes.push(makeNote(a.accountId, asset, 1_000_000n, hLeaf(a.accountId, new Fr(424242n))));
    (l as any).setBalance(a.accountId, asset, l.balanceOf(a.accountId, asset) + 1_000_000n);
    assert.throws(() => UepLedger.restore(l.snapshot(), AUTH), /INVALID_SNAPSHOT_UNMINTED_NOTE/);
  }
  // Signed mint record altered (amount no longer matches its faucet signature).
  {
    const { l } = await ledgerWithHistory();
    l.mints[0]!.amount = "1";
    assert.throws(() => UepLedger.restore(l.snapshot(), AUTH), /INVALID_SNAPSHOT_MINT_SIGNATURE/);
  }
  // Spent flag flipped back to unspent on a consumed note.
  {
    const { l } = await ledgerWithHistory();
    l.notes.find((n) => n.spent)!.spent = false;
    assert.throws(() => UepLedger.restore(l.snapshot(), AUTH), /INVALID_SNAPSHOT_SPENT_FLAG/);
  }
  // Unspent note marked spent.
  {
    const { l, b } = await ledgerWithHistory();
    l.notes.find((n) => !n.spent && n.owner.eq(b.accountId))!.spent = true;
    assert.throws(() => UepLedger.restore(l.snapshot(), AUTH), /INVALID_SNAPSHOT_SPENT_FLAG/);
  }
  // Nullifier seen-set emptied.
  {
    const { l } = await ledgerWithHistory();
    const snap = structuredClone(l.snapshot());
    snap.nullifiers.seen = [];
    assert.throws(() => UepLedger.restore(resign(snap), AUTH), /INVALID_SNAPSHOT_NULLIFIER_SEEN/);
  }
  // Transaction history removed (nullifier root no longer matches).
  {
    const { l } = await ledgerWithHistory();
    const snap = structuredClone(l.snapshot());
    snap.txs = [];
    assert.throws(() => UepLedger.restore(resign(snap), AUTH), /INVALID_SNAPSHOT_NULLIFIER_ROOT/);
  }
  // Security policy omitted.
  {
    const { l } = await ledgerWithHistory();
    const snap = structuredClone(l.snapshot()) as any;
    delete snap.policy;
    assert.throws(() => UepLedger.restore(resign(snap), AUTH), /INVALID_SNAPSHOT_SHAPE/);
  }
  // Legacy formats (v1 without version, v2 HMAC) are rejected with a clear error.
  {
    const { l } = await ledgerWithHistory();
    const snap = structuredClone(l.snapshot()) as any;
    delete snap.formatVersion;
    assert.throws(() => UepLedger.restore(resign(snap), AUTH), /INVALID_SNAPSHOT_VERSION: snapshot formatVersion 1 is no longer supported/);
    snap.formatVersion = 2;
    assert.throws(() => UepLedger.restore(resign(snap), AUTH), /INVALID_SNAPSHOT_VERSION: snapshot formatVersion 2 is no longer supported/);
  }
});

test("B05: restore rejects a signed history containing an unbound or unordered transaction", async () => {
  const [a, b, z] = await Promise.all([identity(), identity(), identity()]);
  const l = newLedger();
  l.faucet(a.accountId, EUR, 10_000n);
  const tx = prepared(l, a, b.accountId, 1_000n);
  const outs = tx.outputNotes!.map(deserializeNote);
  const redirected = reauthorize(l, a, tx, { outputs: [makeNote(z.accountId, asset, 1_000n, outs[0]!.blinding), outs[1]!] });
  assert.ok("tx" in l.submit(tx, a));
  const snap = structuredClone(l.snapshot());
  const forged = structuredClone(snap);
  const honestTx = forged.txs[0]!;
  const bad = { ...honestTx, outputCommitments: redirected.outputCommitments.map((c) => c.toHex()), outputNotes: redirected.outputNotes, transactionCommitment: redirected.transactionCommitment.toHex(), txId: redirected.txId.toHex() };
  forged.txs[0] = bad as typeof honestTx;
  assert.throws(() => UepLedger.restore(resign(forged), AUTH), /INVALID_SNAPSHOT_TX_OUTPUT_BINDING/);
  // Same honest transaction recorded twice.
  const dup = structuredClone(snap);
  dup.txs.push(dup.txs[0]!);
  assert.throws(() => UepLedger.restore(resign(dup), AUTH), /INVALID_SNAPSHOT_TX_DUPLICATE/);
});
