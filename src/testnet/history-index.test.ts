/**
 * v0.5.3 (external review 2026-10-08): the replay checks of submit() and
 * reconcilePending() use O(1) txId / nullifier indexes over the committed
 * history instead of scanning it; the indexes are rebuilt on restore.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { UepLedger } from "./ledger.ts";
import { Fr } from "../core/field.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { TESTNET } from "../network/profiles.ts";
import type { UepTransaction } from "../core/transaction.ts";

const SNAPSHOT_KEY = generateEd25519KeyPair();
const FAUCET_KEY = generateEd25519KeyPair();
const TRUST = { authorities: [SNAPSHOT_KEY.publicKeyHex], faucetPublicKeys: [FAUCET_KEY.publicKeyHex] };
const ASSET = "uep-test/teur";
const mk = () => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey });
const code = (r: { error?: { code: string } } | object) => ("error" in r && r.error ? (r.error as { code: string }).code : "OK");

test("a committed transaction is found through the index; replay is refused before and after restore", async () => {
  const l = mk();
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const b = await identityFromMnemonic(await generateMnemonic(128));
  l.faucet(a.accountId, ASSET, 10_000n);
  const p = l.prepareSpend(a, b.accountId, ASSET, 100n);
  assert.ok("tx" in p);
  assert.equal(l.hasCommittedTx(p.tx.txId), false);
  assert.equal(code(l.submit(p.tx)), "OK");
  assert.equal(l.hasCommittedTx(p.tx.txId), true);
  assert.equal(l.hasCommittedNullifier(p.tx.nullifier), true);
  assert.match(code(l.submit(p.tx)), /REPLAY|DOUBLE_SPEND/);
  const restored = UepLedger.restore(l.snapshot(), TRUST);
  assert.equal(restored.hasCommittedTx(p.tx.txId), true, "index rebuilt on restore");
  assert.equal(restored.hasCommittedNullifier(p.tx.nullifier), true);
  assert.match(code(restored.submit(p.tx)), /REPLAY|DOUBLE_SPEND/);
  // Offline: a queued copy of a committed spend is rejected by reconcilePending (indexed nullifier check).
  restored.connected = false;
  restored.pending.push({ ...p.tx });
  const rec = restored.reconcilePending();
  assert.equal(rec.rejected.length, 1);
  assert.equal(rec.rejected[0]!.code, "REPLAY");
});

test("the index follows `txs` when the array is replaced and does not scan the history per lookup", () => {
  const l = mk();
  let reads = 0; // counts txId reads: a history scan per lookup would read every entry again
  const synth = (i: number) => {
    const txId = new Fr(BigInt(i) * 7n + 1n);
    return { get txId() { reads++; return txId; }, nullifier: new Fr(BigInt(i) * 11n + 3n) } as unknown as UepTransaction;
  };
  l.txs = Array.from({ length: 1_000 }, (_, i) => synth(i));
  assert.equal(l.hasCommittedTx(new Fr(7n * 999n + 1n)), true);
  l.txs = Array.from({ length: 100_000 }, (_, i) => synth(i));
  assert.equal(l.hasCommittedTx(new Fr(7n * 99_999n + 1n)), true, "rebuilt after the array was replaced");
  assert.equal(l.hasCommittedTx(new Fr(2n)), false);
  // After the one-time build, a lookup is a Set probe: 10 000 lookups (hits and misses) read no
  // history entry at all (deterministic; no timing).
  const probe = new Fr(123_456_789n);
  const before = reads;
  for (let i = 0; i < 10_000; i++) { l.hasCommittedTx(probe); l.hasCommittedTx(new Fr(7n * BigInt(i) + 1n)); }
  assert.equal(reads, before, "no history entry is read per lookup");
  l.txs.push(synth(200_000));
  assert.equal(l.hasCommittedTx(new Fr(7n * 200_000n + 1n)), true, "appended transactions are indexed incrementally");
  assert.equal(reads, before + 1, "an append indexes only the new entry");
});
