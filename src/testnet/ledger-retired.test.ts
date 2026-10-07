/**
 * v0.5.3: a ledger replaced by restore(..., { replaces }) is retired: it
 * refuses spends (submit, submitBatch, prepare*), faucet mints, issuer-key
 * changes, settlement anchors, height advances and snapshot signing, so the
 * same note cannot be spent in two live, signable histories.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { UepLedger } from "./ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { identityFromMnemonic, entropyToMnemonic } from "../identity/index.ts";

const EUR = "uep-test/teur";

test("retired ledger: spend, batch, faucet, issuer key, height and snapshot are refused with LEDGER_RETIRED; the restored ledger works", async () => {
  const F = generateEd25519KeyPair(), S = generateEd25519KeyPair();
  const trust = { authorities: [S.publicKeyHex], faucetPublicKeys: [F.publicKeyHex] };
  const L = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, faucetSigningKey: F.privateKey, snapshotSigningKeys: [S.privateKey] });
  const id = async (b: number) => identityFromMnemonic(await entropyToMnemonic(new Uint8Array(16).fill(b)));
  const a = await id(0x81), b = await id(0x82), c = await id(0x83);
  L.faucet(a.accountId, EUR, 1000n);
  L.advanceHeight(2);
  // Prepared before the restore: submitting it afterwards must still be refused.
  const early = L.prepareSpend(a, b.accountId, EUR, 50n);
  assert.ok("tx" in early);
  const R = UepLedger.restore(L.snapshot(), trust, { snapshotSigningKeys: [S.privateKey], faucetSigningKey: F.privateKey }, { replaces: L });
  assert.equal(L.isRetired, true);

  const p = L.prepareSpend(a, b.accountId, EUR, 100n);
  assert.ok("error" in p && p.error.code === "LEDGER_RETIRED");
  const sub = L.submit(early.tx);
  assert.ok("error" in sub && sub.error.code === "LEDGER_RETIRED");
  const batch = L.submitBatch([early.tx]);
  assert.ok("error" in batch && batch.error.code === "LEDGER_RETIRED");
  const pay = L.preparePayment(a, b.accountId, EUR, 10n);
  assert.ok("error" in pay && pay.error.code === "LEDGER_RETIRED");
  assert.throws(() => L.faucet(b.accountId, EUR, 5n), /LEDGER_RETIRED/);
  assert.throws(() => L.setIssuerSigningKey(EUR, null), /LEDGER_RETIRED/);
  assert.throws(() => L.advanceHeight(1), /LEDGER_RETIRED/);
  assert.throws(() => L.snapshot(), /LEDGER_RETIRED/);

  // The restored ledger is the only live history.
  const q = R.prepareSpend(a, c.accountId, EUR, 100n);
  assert.ok("tx" in q);
  assert.ok("tx" in R.submit(q.tx));
  assert.equal(R.balanceOfAsset(c.accountId, EUR), 100n);
  assert.equal(L.balanceOfAsset(b.accountId, EUR), 0n);
  assert.ok(R.snapshot().snapshotHash);
});
