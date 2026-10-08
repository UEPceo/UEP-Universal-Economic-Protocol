/**
 * v0.5.3 (external review 2026-10-08): the ledger's Poseidon / SMT work runs on
 * a worker thread, so the service event loop is not blocked by submits; the
 * worker reaches the same state as an in-process ledger.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LedgerWorkerHost } from "./ledger-worker-host.ts";
import { LedgerSubmitQueue } from "./ledger-submit-queue.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { TESTNET } from "../network/profiles.ts";
import type { UepTransaction } from "../core/transaction.ts";

const ASSET = "uep-test/teur";
const SNAPSHOT_KEY = generateEd25519KeyPair();
const FAUCET_KEY = generateEd25519KeyPair();
const TRUST = { authorities: [SNAPSHOT_KEY.publicKeyHex], faucetPublicKeys: [FAUCET_KEY.publicKeyHex] };

async function preparedLedger(n: number) {
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey });
  const recipient = await identityFromMnemonic(await generateMnemonic(128));
  const senders = [];
  for (let i = 0; i < n; i++) {
    const s = await identityFromMnemonic(await generateMnemonic(128));
    l.faucet(s.accountId, ASSET, 10_000n);
    senders.push(s);
  }
  const snapshot = l.snapshot();
  const txs: UepTransaction[] = [];
  for (const s of senders) {
    const p = l.prepareSpend(s, recipient.accountId, ASSET, 100n);
    assert.ok("tx" in p);
    txs.push(p.tx);
  }
  return { l, snapshot, txs };
}

/** Largest gap between 5 ms timer ticks while `work` runs (event-loop blocking). */
async function maxTimerGap(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let gap = 0;
  const t = setInterval(() => { const n = performance.now(); gap = Math.max(gap, n - last); last = n; }, 5);
  try { await work(); } finally { clearInterval(t); }
  return gap;
}

test("submits through the worker host keep the event loop responsive and reach the same state as in-process submits", async () => {
  const { l, snapshot, txs } = await preparedLedger(3);
  const host = await LedgerWorkerHost.start({ mode: "restore", snapshot, trust: TRUST, keys: { snapshotSigningKeys: [SNAPSHOT_KEY.privateKey] } });
  try {
    const queue = new LedgerSubmitQueue(host, { maxDepth: 16 });
    const workerGap = await maxTimerGap(async () => {
      const results = await Promise.all(txs.map((tx) => queue.submit(tx)));
      assert.deepEqual(results.map((r) => ("error" in r ? r.error.code : "OK")), ["OK", "OK", "OK"]);
    });
    // Same transactions in process (blocking) for comparison and parity.
    const inProcessGap = await maxTimerGap(async () => {
      for (const tx of txs) { assert.ok("tx" in l.submit(tx)); await new Promise((r) => setImmediate(r)); }
    });
    const status = await host.status();
    assert.equal(status.stateRoot, l.stateRoot().toHex(), "worker state equals in-process state");
    assert.equal(status.txCount, 3);
    // A replay is refused in the worker too.
    const replay = await host.submit(txs[0]!);
    assert.ok("error" in replay);
    // The worker path does not block for a whole submit (each in-process submit blocks for its full duration).
    assert.ok(workerGap < inProcessGap, `worker gap ${workerGap.toFixed(0)} ms, in-process gap ${inProcessGap.toFixed(0)} ms`);
    assert.ok(workerGap < 150, `worker gap ${workerGap.toFixed(0)} ms`);
  } finally {
    await host.close();
  }
});

test("a worker restore with an untrusted snapshot fails at start", async () => {
  const { snapshot } = await preparedLedger(1);
  await assert.rejects(LedgerWorkerHost.start({ mode: "restore", snapshot, trust: { authorities: [generateEd25519KeyPair().publicKeyHex], faucetPublicKeys: [FAUCET_KEY.publicKeyHex] } }), /INVALID_SNAPSHOT|SNAPSHOT/);
});
