/**
 * v0.5.3 (external review 2026-10-08): reproducible measurement of the
 * Poseidon BN254 / SMT depth-254 cost of the ledger and of the event-loop
 * blocking with and without the worker host. Prints JSON; numbers depend on
 * the machine. Not part of test:all.
 *
 *   node --experimental-strip-types --no-warnings scripts/bench-ledger-cost.ts
 */
import { SparseMerkleTree } from "../src/core/smt.ts";
import { Fr } from "../src/core/field.ts";
import { hMerkle } from "../src/core/hash.ts";
import { UepLedger } from "../src/testnet/ledger.ts";
import { generateEd25519KeyPair } from "../src/core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../src/identity/index.ts";
import { TESTNET } from "../src/network/profiles.ts";
import { LedgerWorkerHost } from "../src/service/ledger-worker-host.ts";
import { LedgerSubmitQueue } from "../src/service/ledger-submit-queue.ts";

const out: Record<string, string> = { node: process.version };
{
  let x = new Fr(1n);
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) x = hMerkle(x, new Fr(BigInt(i) + 3n));
  out.hMerkleMicros = (((performance.now() - t0) / 2000) * 1000).toFixed(1);
}
{
  const t = new SparseMerkleTree(254);
  const t0 = performance.now();
  for (let i = 1; i <= 30; i++) t.set(new Fr(BigInt(i) * 7919n ** 20n), new Fr(BigInt(i)));
  t.root();
  out.smt254SetMs = ((performance.now() - t0) / 30).toFixed(1);
}
const SNAPSHOT_KEY = generateEd25519KeyPair();
const FAUCET_KEY = generateEd25519KeyPair();
const N = 6;
const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey });
const recipient = await identityFromMnemonic(await generateMnemonic(128));
const senders = [];
for (let i = 0; i < N; i++) { const s = await identityFromMnemonic(await generateMnemonic(128)); l.faucet(s.accountId, "uep-test/teur", 10_000n); senders.push(s); }
const snapshot = l.snapshot();
const txs = senders.map((s) => { const p = l.prepareSpend(s, recipient.accountId, "uep-test/teur", 100n); if (!("tx" in p)) throw new Error("prepare"); return p.tx; });
async function gap(work: () => Promise<unknown>): Promise<[number, number]> {
  let last = performance.now(); let g = 0;
  const t = setInterval(() => { const n = performance.now(); g = Math.max(g, n - last); last = n; }, 5);
  const t0 = performance.now();
  try { await work(); } finally { clearInterval(t); }
  return [g, performance.now() - t0];
}
const host = await LedgerWorkerHost.start({ mode: "restore", snapshot, trust: { authorities: [SNAPSHOT_KEY.publicKeyHex], faucetPublicKeys: [FAUCET_KEY.publicKeyHex] }, keys: { snapshotSigningKeys: [SNAPSHOT_KEY.privateKey] } });
const q = new LedgerSubmitQueue(host);
const [wg, wt] = await gap(() => Promise.all(txs.map((tx) => q.submit(tx))));
const [ig, it] = await gap(async () => { for (const tx of txs) { l.submit(tx); await new Promise((r) => setImmediate(r)); } });
await host.close();
out.submitMsInProcess = (it / N).toFixed(0);
out.submitMsWorker = (wt / N).toFixed(0);
out.maxEventLoopGapMsInProcess = ig.toFixed(0);
out.maxEventLoopGapMsWorker = wg.toFixed(0);
console.log(JSON.stringify(out, null, 1));
