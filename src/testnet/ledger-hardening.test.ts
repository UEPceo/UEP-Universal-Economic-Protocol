import test from "node:test";
import assert from "node:assert/strict";
import { Fr } from "../core/field.ts";
import { encodeStringToFr } from "../core/index.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { UepLedger } from "./ledger.ts";
import { TESTNET } from "../network/profiles.ts";

async function ids() {
  return {
    a: await identityFromMnemonic(await generateMnemonic(128)),
    b: await identityFromMnemonic(await generateMnemonic(128)),
  };
}
function ledger() {
  return new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
}

test("change is amount minus fee and note conservation holds", async () => {
  const { a, b } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "asset:test:eur", 100_500n);
  const p = l.prepareSpend(a, b.accountId, "asset:test:eur", 100_000n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  assert.equal(p.tx.fee, 100n);
  assert.ok(p.tx.inputNotes);
  assert.ok(p.tx.outputNotes);
  assert.equal(p.tx.outputNotes!.reduce((s, n) => s + BigInt(n.amount), 0n), 100_400n);
  assert.ok("tx" in l.submit(p.tx, a));
  const asset = encodeStringToFr("asset:test:eur");
  assert.equal(l.balanceOf(a.accountId, asset), 400n);
  assert.equal(l.balanceOf(b.accountId, asset), 100_000n);
  assert.equal(l.balanceOf(new Fr(0n), asset), 0n);
});

test("output and input notes travel with a transaction and survive replica apply", async () => {
  const { a, b } = await ids();
  const source = ledger();
  source.faucet(a.accountId, "asset:test:eur", 100_500n);
  const before = source.snapshot();
  const p = source.prepareSpend(a, b.accountId, "asset:test:eur", 100_000n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  assert.ok(p.tx.inputNotes?.length === 1);
  assert.ok(p.tx.outputNotes?.length === 2);

  const replica = UepLedger.restore(before);
  const result = replica.submit(p.tx, a);
  assert.ok("tx" in result);
  assert.equal(replica.notesOf(b.accountId).length, 1);
  assert.equal(replica.notesOf(a.accountId).reduce((s, n) => s + n.amount, 0n), 400n);
});

test("restore rejects tampered balance/state root", async () => {
  const { a } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "asset:test:eur", 1000n);
  const snap = l.snapshot();
  const tampered = structuredClone(snap) as typeof snap;
  tampered.balances[0]![1] = "999999999";
  assert.throws(() => UepLedger.restore(tampered), /INVALID_SNAPSHOT_STATE_ROOT/);
});

test("restore rejects tampered note commitment", async () => {
  const { a } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "asset:test:eur", 1000n);
  const snap = l.snapshot();
  const tampered = structuredClone(snap) as typeof snap;
  tampered.notes[0]!.commitment = "01".padStart(64, "0");
  assert.throws(() => UepLedger.restore(tampered), /INVALID_SNAPSHOT_NOTE_COMMITMENT/);
});

test("restore rejects tampered nullifier tree", async () => {
  const { a, b } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "asset:test:eur", 1000n);
  const p = l.prepareSpend(a, b.accountId, "asset:test:eur", 100n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  assert.ok("tx" in l.submit(p.tx, a));
  const snap = l.snapshot();
  const tampered = structuredClone(snap) as typeof snap;
  tampered.nullifiers.tree.leaves[0]![1] = "02".padStart(64, "0");
  assert.throws(() => UepLedger.restore(tampered), /INVALID_SNAPSHOT_NULLIFIER_ROOT/);
});

test("reconcile keeps a valid pending transaction queued and rejects an invented one", async () => {
  const { a, b } = await ids();
  const source = ledger();
  source.faucet(a.accountId, "asset:test:eur", 1000n);
  const l = UepLedger.restore(source.snapshot());
  const asset = encodeStringToFr("asset:test:eur");
  const p = source.prepareSpend(a, b.accountId, "asset:test:eur", 100n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  const fake = { ...p.tx, amount: 999_999n };
  l.queueConflict(p.tx);
  l.queueConflict(fake);
  const rootBefore = l.stateRoot().toHex();

  const r = l.reconcilePending();

  // The invented envelope is rejected and removed from the queue.
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0]!.txId, fake.txId.toHex());
  assert.equal(r.rejected[0]!.code, "AMOUNT_MISMATCH"); // commitment no longer matches the mutated amount
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
  l.faucet(a.accountId, "asset:test:eur", 1000n);
  const p1 = l.prepareSpend(a, b.accountId, "asset:test:eur", 100n);
  const p2 = l.prepareSpend(a, b.accountId, "asset:test:eur", 200n);
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
  l.faucet(a.accountId, "asset:test:eur", 1000n);
  const p = l.prepareSpend(a, b.accountId, "asset:test:eur", 100n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  const result = l.submit(p.tx);
  assert.ok("error" in result);
  if ("error" in result) assert.equal(result.error.code, "PROOF");
});

test("zero-value transactions are rejected", async () => {
  const { a, b } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "asset:test:eur", 1000n);
  const p = l.prepareSpend(a, b.accountId, "asset:test:eur", 0n);
  assert.ok("error" in p);
});
