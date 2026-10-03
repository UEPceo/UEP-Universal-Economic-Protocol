import test from "node:test";
import assert from "node:assert/strict";
import { Fr } from "../core/field.ts";
import { encodeStringToFr } from "../core/index.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { UepLedger, signSnapshot, type UepLedgerSnapshot } from "./ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { deserializeTx, serializeTx, type UepTransaction } from "../core/transaction.ts";
import { signSenderAuth } from "../core/spend-key.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";

/** Re-sign the sender envelope with another identity's spend key. */
function l2sign(tx: UepTransaction, by: IdentitySecrets): UepTransaction {
  return { ...tx, senderAuth: signSenderAuth(tx, by.secret, by.salt) };
}
const SNAPSHOT_KEY = generateEd25519KeyPair();
const FAUCET_KEY = generateEd25519KeyPair();
/** Public trust anchors (what a verifier needs). */
const TRUST = { authorities: [SNAPSHOT_KEY.publicKeyHex], faucetPublicKeys: [FAUCET_KEY.publicKeyHex] };
/** Private keys of the authority node (only needed to keep signing after restore). */
const NODE_KEYS = { snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey };

import { TESTNET } from "../network/profiles.ts";

async function ids() {
  return {
    a: await identityFromMnemonic(await generateMnemonic(128)),
    b: await identityFromMnemonic(await generateMnemonic(128)),
  };
}
/** Re-sign a modified snapshot with the correct authority key (simulates a forger holding the snapshot key). */
function resign(snap: UepLedgerSnapshot): UepLedgerSnapshot {
  return signSnapshot(snap, [SNAPSHOT_KEY.privateKey]);
}

function ledger() {
  return new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey });
}

test("change is amount minus fee and note conservation holds", async () => {
  const { a, b } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "uep-test/teur", 100_500n);
  const p = l.prepareSpend(a, b.accountId, "uep-test/teur", 100_000n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  assert.equal(p.tx.fee, 100n);
  assert.ok(p.tx.inputNotes);
  assert.ok(p.tx.outputNotes);
  assert.equal(p.tx.outputNotes!.reduce((s, n) => s + BigInt(n.amount), 0n), 100_400n);
  assert.ok("tx" in l.submit(p.tx, a));
  const asset = encodeStringToFr("uep-test/teur");
  assert.equal(l.balanceOf(a.accountId, asset), 400n);
  assert.equal(l.balanceOf(b.accountId, asset), 100_000n);
  assert.equal(l.balanceOf(new Fr(0n), asset), 0n);
});

test("output and input notes travel with a transaction and survive replica apply", async () => {
  const { a, b } = await ids();
  const source = ledger();
  source.faucet(a.accountId, "uep-test/teur", 100_500n);
  const before = source.snapshot();
  const p = source.prepareSpend(a, b.accountId, "uep-test/teur", 100_000n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  assert.ok(p.tx.inputNotes?.length === 1);
  assert.ok(p.tx.outputNotes?.length === 2);

  const replica = UepLedger.restore(before, TRUST, NODE_KEYS);
  const result = replica.submit(p.tx, a);
  assert.ok("tx" in result);
  assert.equal(replica.notesOf(b.accountId).length, 1);
  assert.equal(replica.notesOf(a.accountId).reduce((s, n) => s + n.amount, 0n), 400n);
});

test("restore rejects tampered balance/state root", async () => {
  const { a } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "uep-test/teur", 1000n);
  const snap = l.snapshot();
  const tampered = structuredClone(snap) as typeof snap;
  tampered.balances[0]![1] = "999999999";
  assert.throws(() => UepLedger.restore(tampered, TRUST), /INVALID_SNAPSHOT_HASH/);
  assert.throws(() => UepLedger.restore(resign(tampered), TRUST, NODE_KEYS), /INVALID_SNAPSHOT_STATE_ROOT/);
});

test("restore rejects tampered note commitment", async () => {
  const { a } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "uep-test/teur", 1000n);
  const snap = l.snapshot();
  const tampered = structuredClone(snap) as typeof snap;
  tampered.notes[0]!.commitment = "01".padStart(64, "0");
  assert.throws(() => UepLedger.restore(tampered, TRUST), /INVALID_SNAPSHOT_HASH/);
  assert.throws(() => UepLedger.restore(resign(tampered), TRUST, NODE_KEYS), /INVALID_SNAPSHOT_NOTE_COMMITMENT/);
});

test("restore rejects tampered nullifier tree", async () => {
  const { a, b } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "uep-test/teur", 1000n);
  const p = l.prepareSpend(a, b.accountId, "uep-test/teur", 100n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  assert.ok("tx" in l.submit(p.tx, a));
  const snap = l.snapshot();
  const tampered = structuredClone(snap) as typeof snap;
  tampered.nullifiers.tree.leaves[0]![1] = "02".padStart(64, "0");
  assert.throws(() => UepLedger.restore(tampered, TRUST), /INVALID_SNAPSHOT_HASH/);
  assert.throws(() => UepLedger.restore(resign(tampered), TRUST, NODE_KEYS), /INVALID_SNAPSHOT_NULLIFIER_ROOT/);
});

test("reconcile keeps a valid pending transaction queued and rejects an invented one", async () => {
  const { a, b } = await ids();
  const source = ledger();
  source.faucet(a.accountId, "uep-test/teur", 1000n);
  const l = UepLedger.restore(source.snapshot(), TRUST, NODE_KEYS);
  const asset = encodeStringToFr("uep-test/teur");
  const p = source.prepareSpend(a, b.accountId, "uep-test/teur", 100n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  const fake = { ...p.tx, amount: 999_999n };
  // v0.4.4: the invented envelope is refused at enqueue time.
  const refused = l.queueConflict(fake);
  assert.ok("error" in refused && refused.error.code === "AMOUNT_MISMATCH"); // commitment no longer matches the mutated amount
  assert.ok("tx" in l.queueConflict(p.tx));
  const dup = l.queueConflict(p.tx);
  assert.ok("error" in dup && dup.error.code === "REPLAY");
  assert.equal(l.pending.length, 1);
  const rootBefore = l.stateRoot().toHex();

  const r = l.reconcilePending();

  assert.equal(r.rejected.length, 0);
  // The valid spend stays queued (not dropped) and is not settled or applied.
  assert.equal(r.queued.length, 1);
  assert.ok(r.queued[0]!.txId.eq(p.tx.txId));
  assert.equal(r.queued[0]!.amount, 100n);
  assert.equal(r.queued[0]!.phase, "LOCAL_VALID");
  assert.equal(r.settlements.length, 0);
  assert.equal(l.txs.length, 0);
  assert.equal(l.stateRoot().toHex(), rootBefore);
  assert.equal(l.balanceOf(b.accountId, asset), 0n);
  const queuedAgain = l.reconcilePending();
  assert.equal(queuedAgain.queued.length, 1);
  assert.equal(queuedAgain.rejected.length, 0);

  // A queued spend can still be applied through the authenticated submit path,
  // after which reconciliation rejects the now-committed nullifier.
  assert.ok("tx" in l.submit(p.tx, a));
  assert.equal(l.balanceOf(b.accountId, asset), 100n);
  const after = l.reconcilePending();
  assert.equal(after.queued.length, 0);
  assert.equal(after.rejected[0]?.code, "REPLAY");
});

test("conflicting valid pending spends stay queued and are flagged", async () => {
  const { a, b } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "uep-test/teur", 1000n);
  const p1 = l.prepareSpend(a, b.accountId, "uep-test/teur", 100n);
  const p2 = l.prepareSpend(a, b.accountId, "uep-test/teur", 200n);
  assert.ok("tx" in p1 && "tx" in p2);
  if (!("tx" in p1) || !("tx" in p2)) return;
  assert.ok(p1.tx.nullifier.eq(p2.tx.nullifier));
  l.queueConflict(p1.tx);
  l.queueConflict(p2.tx);
  const r = l.reconcilePending();
  assert.equal(r.rejected.length, 0);
  assert.equal(r.queued.length, 2);
  assert.ok(r.queued.every((t) => t.inConflict && t.phase === "LOCAL_VALID"));
  assert.equal(l.txs.length, 0);
});

test("bare transactions cannot bypass ownership authorization", async () => {
  const { a, b } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "uep-test/teur", 1000n);
  // A local development-MAC spend needs the sender identity in-process.
  const p = l.prepareSpend(a, b.accountId, "uep-test/teur", 100n, l.height, { authorization: "development-mac" });
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  const result = l.submit(p.tx);
  assert.ok("error" in result);
  if ("error" in result) assert.equal(result.error.code, "PROOF");
  // Relabelling it as a sender-signature spend does not help: its nullifier is not the sender-bound one.
  const relabelled = l.submit({ ...p.tx, spendProof: { kind: "sender-signature", backend: "ed25519-key-derived-account", payload: "" } });
  assert.ok("error" in relabelled && relabelled.error.code === "WRONG_OWNER");
  // A signed spend without its sender signature is rejected.
  const s = l.prepareSpend(a, b.accountId, "uep-test/teur", 100n);
  assert.ok("tx" in s);
  if (!("tx" in s)) return;
  const unsigned = l.submit({ ...s.tx, senderAuth: undefined });
  assert.ok("error" in unsigned && unsigned.error.code === "SENDER_AUTH");
});

test("remote path: a signed spend is verified with the public key only (no secret reaches the node)", async () => {
  const { a, b } = await ids();
  const client = ledger();
  client.faucet(a.accountId, "uep-test/teur", 1000n);
  // The client builds and signs on its own replica; the node only sees the serialized transaction.
  const node = UepLedger.restore(client.snapshot(), TRUST);
  const p = client.prepareSpend(a, b.accountId, "uep-test/teur", 100n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  assert.equal(p.tx.spendProof.kind, "sender-signature");
  const wire = deserializeTx(JSON.parse(JSON.stringify(serializeTx(p.tx))));
  // Another account cannot take over the spend by re-signing it.
  const other = l2sign(wire, b);
  assert.ok("error" in node.submit(other));
  const accepted = node.submit(wire);
  assert.ok("tx" in accepted, "error" in accepted ? accepted.error.message : "");
  assert.equal(node.balanceOf(b.accountId, encodeStringToFr("uep-test/teur")), 100n);
  // Replay is rejected.
  assert.ok("error" in node.submit(wire));
});

test("zero-value transactions are rejected", async () => {
  const { a, b } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "uep-test/teur", 1000n);
  const p = l.prepareSpend(a, b.accountId, "uep-test/teur", 0n);
  assert.ok("error" in p);
});

test("submit rejects a fabricated self-consistent input note", async () => {
  const { a, b } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "uep-test/teur", 1000n);
  const p = l.prepareSpend(a, b.accountId, "uep-test/teur", 100n);
  assert.ok("tx" in p); if (!("tx" in p)) return;
  const fake = { ...p.tx, inputNotes: p.tx.inputNotes!.map((n) => ({ ...n, amount: "999999" })) };
  assert.ok("error" in l.submit(fake, a));
  assert.equal(l.balanceOf(b.accountId, encodeStringToFr("uep-test/teur")), 0n);
});

test("restore requires the snapshot authority signature and rejects a coherent forged snapshot", async () => {
  const { a } = await ids();
  const l = ledger(); l.faucet(a.accountId, "uep-test/teur", 1000n);
  const snap = l.snapshot();
  assert.throws(() => UepLedger.restore(snap, { ...TRUST, authorities: [generateEd25519KeyPair().publicKeyHex] }), /INVALID_SNAPSHOT_THRESHOLD/);
  const tampered = structuredClone(snap) as typeof snap;
  tampered.balances[0]![1] = "999999";
  assert.throws(() => UepLedger.restore(tampered, TRUST), /INVALID_SNAPSHOT_HASH/);
  // Internally consistent snapshot produced under a different authority (default ephemeral keys).
  const other = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
  other.faucet(a.accountId, "uep-test/teur", 1_000_000n);
  assert.throws(() => UepLedger.restore(other.snapshot(), TRUST), /INVALID_SNAPSHOT_THRESHOLD/);
  const metadata = structuredClone(snap) as typeof snap;
  metadata.noteCounter = "42";
  assert.throws(() => UepLedger.restore(metadata, TRUST), /INVALID_SNAPSHOT_HASH/);
});

test("exact-note balance can pay amount plus fee", async () => {
  const { a, b } = await ids();
  const l = ledger(); l.faucet(a.accountId, "uep-test/teur", 100100n);
  const p = l.prepareSpend(a, b.accountId, "uep-test/teur", 100000n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  assert.equal(p.tx.outputNotes!.reduce((s,n)=>s+BigInt(n.amount),0n), 100000n);
});

test("honest snapshot restores after one or more submits", async () => {
  const { a, b } = await ids();
  const asset = encodeStringToFr("uep-test/teur");
  const l = ledger();
  l.faucet(a.accountId, "uep-test/teur", 100_500n);
  l.faucet(a.accountId, "uep-test/teur", 1_001n);
  // With change output.
  const p1 = l.prepareSpend(a, b.accountId, "uep-test/teur", 100_000n);
  assert.ok("tx" in p1); if (!("tx" in p1)) return;
  assert.ok("tx" in l.submit(p1.tx, a));
  const afterOne = UepLedger.restore(l.snapshot(), TRUST, NODE_KEYS);
  assert.equal(afterOne.stateRoot().toHex(), l.stateRoot().toHex());
  assert.equal(afterOne.nullifierRoot().toHex(), l.nullifierRoot().toHex());
  // Exact amount + fee, no change output; then a spend by the recipient.
  const p2 = l.prepareSpend(a, b.accountId, "uep-test/teur", 1_000n);
  assert.ok("tx" in p2); if (!("tx" in p2)) return;
  assert.equal(p2.tx.outputNotes!.length, 1);
  assert.ok("tx" in l.submit(p2.tx, a));
  const p3 = l.prepareSpend(b, a.accountId, "uep-test/teur", 50_000n);
  assert.ok("tx" in p3); if (!("tx" in p3)) return;
  assert.ok("tx" in l.submit(p3.tx, b));
  assert.equal(l.txs.length, 3);

  const restored = UepLedger.restore(structuredClone(l.snapshot()), TRUST, NODE_KEYS);
  assert.equal(restored.stateRoot().toHex(), l.stateRoot().toHex());
  assert.equal(restored.nullifierRoot().toHex(), l.nullifierRoot().toHex());
  assert.equal(restored.txs.length, 3);
  assert.equal(restored.balanceOf(a.accountId, asset), l.balanceOf(a.accountId, asset));
  assert.equal(restored.balanceOf(b.accountId, asset), l.balanceOf(b.accountId, asset));
  // The restored ledger keeps working and its own snapshot restores again.
  const p4 = restored.prepareSpend(b, a.accountId, "uep-test/teur", 10_000n);
  assert.ok("tx" in p4); if (!("tx" in p4)) return;
  assert.ok("tx" in restored.submit(p4.tx, b));
  assert.ok(UepLedger.restore(restored.snapshot(), TRUST, NODE_KEYS));
});

test("a valid pending transaction survives reconciliation and snapshot restore", async () => {
  const { a, b } = await ids();
  const asset = encodeStringToFr("uep-test/teur");
  const source = ledger();
  source.faucet(a.accountId, "uep-test/teur", 1000n);
  const l = UepLedger.restore(source.snapshot(), TRUST, NODE_KEYS);
  const p = source.prepareSpend(a, b.accountId, "uep-test/teur", 100n);
  assert.ok("tx" in p); if (!("tx" in p)) return;
  assert.ok("tx" in l.queueConflict(p.tx));
  const r = l.reconcilePending();
  assert.equal(r.rejected.length, 0);
  assert.equal(r.settlements.length, 0);
  assert.equal(l.pending.length, 1);
  assert.equal(l.pending[0]!.phase, "LOCAL_VALID");
  assert.equal(l.txs.length, 0);
  const restored = UepLedger.restore(l.snapshot(), TRUST, NODE_KEYS);
  assert.equal(restored.pending.length, 1);
  assert.equal(restored.reconcilePending().queued.length, 1);
  assert.ok("tx" in restored.submit(p.tx, a));
  assert.equal(restored.balanceOf(b.accountId, asset), 100n);
});

test("prepareSpend rejects a note that covers the amount but not the fee", async () => {
  const { a, b } = await ids();
  const l = ledger(); l.faucet(a.accountId, "uep-test/teur", 100_000n);
  const p = l.prepareSpend(a, b.accountId, "uep-test/teur", 100_000n);
  assert.ok("error" in p);
  if ("error" in p) assert.equal(p.error.code, "INSUFFICIENT");
});

test("a spent input note cannot be referenced by a second transaction", async () => {
  const { a, b } = await ids();
  const l = ledger(); l.faucet(a.accountId, "uep-test/teur", 1000n);
  const p1 = l.prepareSpend(a, b.accountId, "uep-test/teur", 100n);
  const p2 = l.prepareSpend(a, b.accountId, "uep-test/teur", 200n);
  assert.ok("tx" in p1 && "tx" in p2); if (!("tx" in p1) || !("tx" in p2)) return;
  assert.ok("tx" in l.submit(p1.tx, a));
  const second = l.submit(p2.tx, a);
  assert.ok("error" in second);
  if ("error" in second) assert.equal(second.error.code, "DOUBLE_SPEND");
  assert.equal(l.balanceOf(b.accountId, encodeStringToFr("uep-test/teur")), 100n);
});
