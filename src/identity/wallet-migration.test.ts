/**
 * v0.5.3: a v2 account that only ever received (written by v0.5.0 code, never
 * spent) is visible to the wallet next to the v3 id of the same mnemonic and
 * migrates to it with ordinary signed spends.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { UepLedger, type UepLedgerSnapshot } from "../testnet/ledger.ts";
import { snapshotFromJSON } from "../testnet/snapshot-json.ts";
import { identityFromMnemonic, generateMnemonic } from "./index.ts";
import { migrateV2ToV3, walletAccountBalances } from "./wallet-migration.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/v2-receive-only-v0.5.0.json");
/** Public BIP39 test vector (all-zero entropy): test data only, never a key for value. */
const PUBLIC_TEST_VECTOR = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const EUR = "uep-test/teur";

function load(): { ledger: UepLedger; fx: { receiveOnly: { v2AccountId: string; balance: string; notes: number } } } {
  const fx = snapshotFromJSON<{ trust: { authorities: string[]; faucetPublicKeys: string[] }; chain: UepLedgerSnapshot[]; receiveOnly: { v2AccountId: string; balance: string; notes: number } }>(fs.readFileSync(FIXTURE, "utf8"));
  return { ledger: UepLedger.restoreChain(fx.chain, fx.trust), fx };
}

test("wallet: a v2 receive-only account restored from v0.5.0 state shows next to its v3 id", async () => {
  const { ledger, fx } = load();
  const me = await identityFromMnemonic(PUBLIC_TEST_VECTOR);
  assert.equal(me.accountIdV2!.toHex(), fx.receiveOnly.v2AccountId);
  // Without the helper a wallet looking at the v3 id sees nothing.
  assert.equal(ledger.balanceOfAsset(me.accountId, EUR), 0n);
  const view = walletAccountBalances(ledger, me, EUR);
  assert.equal(view.v3.balance, 0n);
  assert.equal(view.v2.balance, BigInt(fx.receiveOnly.balance));
  assert.equal(view.v2.notes, fx.receiveOnly.notes);
  assert.equal(view.total, 500_000n);
  // The v2 id never spent, so it is not accepted as a recipient yet.
  assert.equal(ledger.acceptsRecipient(me.accountIdV2!), false);
});

test("wallet: migrateV2ToV3 sweeps every v2 note to the v3 id; the 0.1% fee applies; value is conserved", async () => {
  const { ledger } = load();
  const me = await identityFromMnemonic(PUBLIC_TEST_VECTOR);
  const totalBefore = walletAccountBalances(ledger, me, EUR).total;
  const r = migrateV2ToV3(ledger, me, EUR);
  assert.equal(r.txIds.length, 2); // one exact spend per note, no change
  assert.equal(r.dust, 0n);
  assert.equal(r.moved + r.fees, 500_000n);
  assert.ok(r.fees >= 2n && r.fees <= 500n); // 0.1% of each spend (fee floor per spend)
  const after = walletAccountBalances(ledger, me, EUR);
  assert.equal(after.v2.balance, 0n);
  assert.equal(after.v3.balance, r.moved);
  assert.equal(totalBefore - after.total, r.fees);
  // The sweep proved the v2 key: the v2 id is now an accepted recipient (old payers keep working).
  assert.equal(ledger.acceptsRecipient(me.accountIdV2!), true);
  // Running it again does nothing.
  assert.deepEqual(migrateV2ToV3(ledger, me, EUR).txIds, []);
  // The v3 balance spends normally.
  const other = await identityFromMnemonic(await generateMnemonic(128)); // in memory, discarded
  const p = ledger.prepareSpend(me, other.accountId, EUR, 1_000n);
  assert.ok("tx" in p && "tx" in ledger.submit(p.tx));
  assert.throws(() => migrateV2ToV3(ledger, { ...me, accountIdV2: me.accountId }, EUR), /WALLET_V2_SAME_ID/);
});
