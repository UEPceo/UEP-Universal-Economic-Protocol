/**
 * v0.5.3 (external review 2026-10-08): bounded FIFO submit queue with
 * timeout and backpressure in front of the ledger; HTTP 503 + Retry-After.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LedgerSubmitQueue, ledgerBusyHttpStatus, type LedgerSubmitTarget } from "./ledger-submit-queue.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { serializeTx, type UepTransaction } from "../core/transaction.ts";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";

const ASSET = "uep-test/teur";
const fakeTx = (n: number) => ({ n }) as unknown as UepTransaction;

/** A target that takes `ms` (asynchronously) per submission and records the order. */
function slowTarget(ms: number, order: number[]): LedgerSubmitTarget {
  return { submit: async (tx) => { order.push((tx as unknown as { n: number }).n); await new Promise((r) => setTimeout(r, ms)); return { tx }; } };
}

async function signedSpends(ledger: UepLedger, n: number): Promise<UepTransaction[]> {
  const recipient = await identityFromMnemonic(await generateMnemonic(128));
  const out: UepTransaction[] = [];
  for (let i = 0; i < n; i++) {
    const sender = await identityFromMnemonic(await generateMnemonic(128));
    ledger.faucet(sender.accountId, ASSET, 10_000n);
    const p = ledger.prepareSpend(sender, recipient.accountId, ASSET, 100n);
    assert.ok("tx" in p);
    out.push(p.tx);
  }
  return out;
}

test("concurrent async submits of distinct spends all succeed (no LEDGER_BUSY without re-entry); the queue keeps arrival order", async () => {
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
  const txs = await signedSpends(ledger, 4);
  const q = new LedgerSubmitQueue(ledger, { maxDepth: 8 });
  const results = await Promise.all(txs.map((tx) => q.submit(tx)));
  assert.deepEqual(results.map((r) => ("error" in r ? r.error.code : "OK")), ["OK", "OK", "OK", "OK"]);
  assert.equal(q.stats().completed, 4);
});

test("a full queue answers LEDGER_BUSY (QUEUE_FULL) with Retry-After immediately and enqueues nothing", async () => {
  const order: number[] = [];
  const q = new LedgerSubmitQueue(slowTarget(15, order), { maxDepth: 2, timeoutMs: 5_000 });
  const all = await Promise.all([1, 2, 3, 4, 5].map((n) => q.submit(fakeTx(n))));
  const codes = all.map((r) => ("error" in r ? (r.error as { reason?: string }).reason : "OK"));
  // All five arrive in one turn: 1 and 2 fill the queue (maxDepth 2), 3..5 are refused at once.
  assert.deepEqual(codes, ["OK", "OK", "QUEUE_FULL", "QUEUE_FULL", "QUEUE_FULL"]);
  assert.deepEqual(order, [1, 2]);
  const busy = all[2]!;
  assert.ok("error" in busy && busy.error.code === "LEDGER_BUSY");
  assert.ok((busy.error as { retryAfterSeconds: number }).retryAfterSeconds >= 1);
  assert.deepEqual(ledgerBusyHttpStatus(busy), { status: 503, retryAfterSeconds: (busy.error as { retryAfterSeconds: number }).retryAfterSeconds });
  assert.equal(q.stats().rejectedFull, 3);
});

test("a submission that waits longer than timeoutMs is answered QUEUE_TIMEOUT and never runs", async () => {
  const order: number[] = [];
  const q = new LedgerSubmitQueue(slowTarget(60, order), { maxDepth: 10, timeoutMs: 30 });
  const all = await Promise.all([1, 2, 3].map((n) => q.submit(fakeTx(n))));
  assert.equal("error" in all[0]! ? "busy" : "OK", "OK");
  assert.ok(all.slice(1).every((r) => "error" in r && (r.error as { reason: string }).reason === "QUEUE_TIMEOUT"));
  assert.deepEqual(order, [1]);
  assert.equal(q.stats().timedOut, 2);
  assert.equal(q.depth, 0);
});

test("the queue yields to the event loop between ledger turns", async () => {
  const busyFor = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };
  const turns: string[] = [];
  const q = new LedgerSubmitQueue({ submit: (tx) => { busyFor(15); turns.push("job"); return { tx }; } }, { maxDepth: 10 });
  const done = Promise.all([1, 2, 3].map((n) => q.submit(fakeTx(n))));
  const ticker = (async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => setImmediate(r)); turns.push("io"); } })();
  await Promise.all([done, ticker]);
  // An I/O turn runs between two jobs (not all jobs back to back).
  assert.ok(turns.indexOf("io") < turns.lastIndexOf("job"), turns.join(","));
});

test("HTTP: POST /v1/ledger/transactions accepts a spend (202) and answers 503 with Retry-After when the queue is full", async () => {
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
  const [tx] = await signedSpends(ledger, 1);
  const q = new LedgerSubmitQueue(ledger, { maxDepth: 1 });
  const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]) });
  const { server, port } = await listenUepHttpApi({ api, ledgerQueue: q });
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/v1/ledger/transactions`, { method: "POST", body: JSON.stringify({ tx: serializeTx(tx!) }) });
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).data.txId, tx!.txId.toHex());
    const replay = await fetch(`http://127.0.0.1:${port}/v1/ledger/transactions`, { method: "POST", body: JSON.stringify({ tx: serializeTx(tx!) }) });
    assert.equal(replay.status, 400);
    // Fill the queue: a blocked item counts as waiting.
    (q as unknown as { live: number }).live = 1;
    const full = await fetch(`http://127.0.0.1:${port}/v1/ledger/transactions`, { method: "POST", body: JSON.stringify({ tx: serializeTx(tx!) }) });
    assert.equal(full.status, 503);
    assert.ok(Number(full.headers.get("retry-after")) >= 1);
    assert.equal((await full.json()).error.code, "LEDGER_BUSY");
    (q as unknown as { live: number }).live = 0;
  } finally {
    q.close();
    await new Promise((r) => server.close(r));
  }
});

test("queue options are validated", () => {
  assert.throws(() => new LedgerSubmitQueue({} as LedgerSubmitTarget), /TARGET_INVALID/);
  assert.throws(() => new LedgerSubmitQueue({ submit: () => ({ tx: fakeTx(0) }) }, { maxDepth: 0 }), /CONFIG_INVALID/);
  assert.throws(() => new LedgerSubmitQueue({ submit: () => ({ tx: fakeTx(0) }) }, { timeoutMs: -1 }), /CONFIG_INVALID/);
});
