/**
 * v0.5.2 attack battery (CRITICAL): two spends of one note submitted
 * concurrently. The ledger's check + nullifier insert + apply run in one
 * synchronous turn; re-entry is refused (LEDGER_BUSY); adapters that await an
 * asynchronous verifier serialize through SpendSerializer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { encodeStringToFr } from "../core/encoding.ts";
import type { UepTransaction } from "../core/transaction.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";
import type { Fr } from "../core/field.ts";
import { UepLedger } from "./ledger.ts";
import { SpendSerializer } from "./spend-serializer.ts";
import { TESTNET } from "../network/profiles.ts";

const EUR = "uep-test/teur";
const asset = encodeStringToFr(EUR);
const newLedger = () => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
const identity = async () => identityFromMnemonic(await generateMnemonic(128));

function prepared(l: UepLedger, from: IdentitySecrets, to: Fr, amount: bigint): UepTransaction {
  const p = l.prepareSpend(from, to, EUR, amount);
  assert.ok("tx" in p, "error" in p ? p.error.code : "");
  return (p as { tx: UepTransaction }).tx;
}

/** Two spends of the same (single) note to different recipients, prepared before either is applied. */
async function conflictingSpends() {
  const [a, b, c] = await Promise.all([identity(), identity(), identity()]);
  const l = newLedger();
  l.faucet(a.accountId, EUR, 1_000n);
  const toB = prepared(l, a, b.accountId, 900n);
  const toC = prepared(l, a, c.accountId, 900n);
  assert.equal(toB.inputCommitments[0]!.toHex(), toC.inputCommitments[0]!.toHex(), "both spends use the same note");
  return { l, a, b, c, toB, toC };
}

test("concurrent spends of one note through an async adapter: exactly one is applied", async () => {
  const { l, a, b, c, toB, toC } = await conflictingSpends();
  const verifier = async (tx: UepTransaction) => { await Promise.resolve(); return tx; };
  const results = await Promise.all([toB, toC].map(async (tx) => l.submit(await verifier(tx), a)));
  const accepted = results.filter((r) => "tx" in r);
  const refused = results.filter((r) => "error" in r).map((r) => ("error" in r ? r.error.code : ""));
  assert.equal(accepted.length, 1);
  assert.deepEqual(refused, ["DOUBLE_SPEND"]);
  assert.equal(l.balanceOf(b.accountId, asset) + l.balanceOf(c.accountId, asset), 900n);
});

test("a spend submitted from inside another spend's checks is refused (LEDGER_BUSY) and nothing is applied twice", async () => {
  const { l, a, b, c, toB, toC } = await conflictingSpends();
  let inner: ReturnType<UepLedger["submit"]> | undefined;
  // A transaction object whose field read re-enters the ledger while the outer spend is being checked.
  const reentrant = new Proxy(toB, {
    get(target, key, receiver) {
      if (key === "inputCommitments" && inner === undefined) inner = l.submit(toC, a);
      return Reflect.get(target, key, receiver);
    },
  });
  const outer = l.submit(reentrant, a);
  assert.ok(inner && "error" in inner && inner.error.code === "LEDGER_BUSY");
  assert.ok("tx" in outer);
  assert.equal(l.balanceOf(b.accountId, asset), 900n);
  assert.equal(l.balanceOf(c.accountId, asset), 0n);
  // The guard is released after the outer call: the conflicting spend now fails as a double spend.
  const again = l.submit(toC, a);
  assert.ok("error" in again && again.error.code === "DOUBLE_SPEND");
  const batchReentry = new Proxy([toC], { get(t, k, r) { if (k === "length") { const x = l.submit(toC, a); assert.ok("error" in x); } return Reflect.get(t, k, r); } });
  assert.ok("error" in l.submitBatch(batchReentry, a));
});

test("SpendSerializer runs read-verify-submit sequences one at a time (peak 1 vs 2 without it)", async () => {
  const run = async (serialize: boolean) => {
    const { l, a, toB, toC } = await conflictingSpends();
    const serializer = new SpendSerializer();
    let inFlight = 0;
    let peak = 0;
    let verified = 0;
    const adapter = async (tx: UepTransaction) => {
      // Adapter-side pre-check, then an asynchronous verification, then the submit.
      if (l.txs.some((t) => t.inputCommitments.some((cm) => tx.inputCommitments.some((x) => x.eq(cm))))) return "ALREADY_SPENT";
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      verified++;
      inFlight--;
      const r = l.submit(tx, a);
      return "tx" in r ? "OK" : r.error.code;
    };
    const outcomes = await Promise.all([toB, toC].map((tx) => (serialize ? serializer.run(() => adapter(tx)) : adapter(tx))));
    return { outcomes, peak, verified, serializerPeak: serializer.peakConcurrency };
  };
  const without = await run(false);
  assert.equal(without.peak, 2, "without the lock both verifications overlap");
  assert.equal(without.verified, 2);
  assert.deepEqual([...without.outcomes].sort(), ["DOUBLE_SPEND", "OK"], "the ledger still refuses the second spend");
  const withLock = await run(true);
  assert.equal(withLock.peak, 1);
  assert.equal(withLock.serializerPeak, 1);
  assert.equal(withLock.verified, 1, "the second sequence sees the first spend before verifying");
  assert.deepEqual(withLock.outcomes, ["OK", "ALREADY_SPENT"]);
});

test("SpendSerializer keeps going after a failed task", async () => {
  const s = new SpendSerializer();
  const order: number[] = [];
  const a = s.run(async () => { order.push(1); throw new Error("boom"); });
  const b = s.run(() => { order.push(2); return 2; });
  await assert.rejects(a, /boom/);
  assert.equal(await b, 2);
  assert.deepEqual(order, [1, 2]);
});
