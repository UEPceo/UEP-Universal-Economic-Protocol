/**
 * 0.5.82 regression tests for the Aegis-Orbit report on v0.5.81:
 * nullifier reuse is refused atomically, and amount + fee can never exceed inputs
 * (amount = 1, fee = 2 cases).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clientBlinding } from "../core/client-note.ts";
import { encodeStringToFr } from "../core/encoding.ts";
import { deserializeNote } from "../core/note.ts";
import type { UepTransaction } from "../core/transaction.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { UepLedger, checkSpendShape } from "./ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { quoteSettlement } from "../marketplace/economy.ts";
import { qualityScore } from "../agent/agent-simulation.ts";

const EUR = "uep-test/teur";
const asset = encodeStringToFr(EUR);
const newLedger = () => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
const identity = async () => identityFromMnemonic(await generateMnemonic(128));

test("Aegis 0.5.82: replaying an accepted spend is refused (DOUBLE_SPEND) and changes nothing", async () => {
  const [a, b] = await Promise.all([identity(), identity()]);
  const l = newLedger();
  l.faucet(a.accountId, EUR, 1_000n, clientBlinding(11n));
  const p = l.prepareSpend(a, b.accountId, EUR, 500n);
  assert.ok("tx" in p);
  const tx = (p as { tx: UepTransaction }).tx;
  assert.ok("tx" in l.submit(tx, a));
  const balA = l.balanceOf(a.accountId, asset), balB = l.balanceOf(b.accountId, asset);
  const again = l.submit(tx, a);
  assert.ok("error" in again);
  // The identical tx is caught by the replay index first; a different tx reusing
  // the nullifier is DOUBLE_SPEND (concurrent-spend.test.ts).
  assert.ok(["REPLAY", "DOUBLE_SPEND"].includes(again.error.code));
  assert.equal(l.balanceOf(a.accountId, asset), balA);
  assert.equal(l.balanceOf(b.accountId, asset), balB);
});

test("Aegis 0.5.82: amount + fee above inputs is refused (amount = 1, fee = 2, and off-by-one)", async () => {
  const [a, b] = await Promise.all([identity(), identity()]);
  const l = newLedger();
  l.faucet(a.accountId, EUR, 1_000n, clientBlinding(12n));
  const p = l.prepareSpend(a, b.accountId, EUR, 100n);
  assert.ok("tx" in p);
  const tx = (p as { tx: UepTransaction }).tx;
  const inputs = tx.inputNotes!.map(deserializeNote);
  const outputs = tx.outputNotes!.map(deserializeNote);
  const total = inputs.reduce((s, n) => s + n.amount, 0n);
  assert.equal(checkSpendShape({ ...tx, amount: total - 1n, fee: 2n }, inputs, outputs)?.code, "AMOUNT_MISMATCH");
  assert.equal(checkSpendShape({ ...tx, amount: 1n, fee: -2n }, inputs, outputs)?.code, "AMOUNT_MISMATCH");
  assert.equal(checkSpendShape({ ...tx, amount: 0n, fee: 2n }, inputs, outputs)?.code, "AMOUNT_MISMATCH");
  // A 2-unit note: amount = 1 with fee = 2 needs 3 and is refused.
  const small = newLedger();
  small.faucet(a.accountId, EUR, 2n, clientBlinding(13n));
  const sp = small.prepareSpend(a, b.accountId, EUR, 1n);
  assert.ok("tx" in sp);
  const stx = (sp as { tx: UepTransaction }).tx;
  assert.equal(checkSpendShape({ ...stx, amount: 1n, fee: 2n }, stx.inputNotes!.map(deserializeNote), stx.outputNotes!.map(deserializeNote))?.code, "AMOUNT_MISMATCH");
  // Spending the whole 2-unit balance leaves nothing for the fee and is refused.
  let refused = false;
  try { refused = "error" in small.prepareSpend(a, b.accountId, EUR, 2n); } catch { refused = true; }
  assert.ok(refused);
  assert.equal(small.balanceOf(a.accountId, asset), 2n);
});

test("Aegis 0.5.82: marketplace fee never exceeds gross (providerNet >= 0)", () => {
  for (const gross of [1n, 2n, 3n, 10n, 1_000n]) {
    const q = quoteSettlement(gross, EUR);
    assert.ok(q.marketplaceFee <= gross && q.providerNet >= 0n);
    assert.equal(q.providerNet + q.marketplaceFee, gross);
  }
});

test("Aegis 0.5.82: agent quality score is integer-scaled and deterministic", () => {
  assert.equal(typeof qualityScore(0.5, 10n), "bigint");
  assert.equal(qualityScore(0.5, 10n), qualityScore(0.5, 10n));
  assert.ok(qualityScore(0.9, 10n) > qualityScore(0.5, 10n));
  assert.ok(qualityScore(0.5, 5n) > qualityScore(0.5, 50n));
  assert.equal(qualityScore(Number.NaN, 1n), 0n);
});
