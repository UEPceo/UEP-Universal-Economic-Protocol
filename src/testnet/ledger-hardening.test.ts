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

test("reconcile ignores an invented pending transaction", async () => {
  const { a, b } = await ids();
  const l = ledger();
  l.faucet(a.accountId, "asset:test:eur", 1000n);
  const p = l.prepareSpend(a, b.accountId, "asset:test:eur", 100n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  const fake = { ...p.tx, amount: 999_999n };
  l.queueConflict(fake);
  l.reconcilePending();
  assert.equal(l.txs.some((t) => t.txId.eq(fake.txId)), false);
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
