/**
 * UEP-35.5 benchmarks — LAB / single-process only.
 * Does NOT claim network TPS.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { ScaleMempool } from "./uep35-scale-mempool.ts";
import { partitionByConflictGraph } from "./uep35-conflict-graph.ts";
import {
  sequentialExecution,
  parallelExecution,
} from "./uep35-batch-execute.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";

function makeTxs(n: number, accounts: number): BatchTx[] {
  const txs: BatchTx[] = [];
  for (let i = 0; i < n; i++) {
    const from = i % accounts;
    let to = (i * 3 + 1) % accounts;
    if (to === from) to = (to + 1) % accounts;
    txs.push({
      id: `tx-${i}`,
      from: `a${from}`,
      to: `a${to}`,
      amount: 1n,
    });
  }
  return txs;
}

async function bench(n: number) {
  const accounts = Math.min(50, Math.max(4, Math.floor(Math.sqrt(n))));
  const acc = [];
  for (let i = 0; i < accounts; i++) {
    acc.push({ label: `a${i}`, balance: 1_000_000n });
  }
  const txs = makeTxs(n, accounts);

  const t0 = performance.now();
  const mp = new ScaleMempool({ maxBatchSize: 128, maxBatchBytes: 1_000_000, maxPending: n + 10 });
  mp.admitMany(txs);
  const intakeMs = performance.now() - t0;

  const t1 = performance.now();
  const batches = [];
  while (mp.size() > 0) batches.push(mp.takeBatch());
  const batchingMs = performance.now() - t1;

  const t2 = performance.now();
  const waves = partitionByConflictGraph(txs);
  const conflictMs = performance.now() - t2;

  const t3 = performance.now();
  const seq = await sequentialExecution(acc, txs.slice(0, Math.min(n, 200)));
  const seqMs = performance.now() - t3;

  const t4 = performance.now();
  const par = await parallelExecution(acc, txs.slice(0, Math.min(n, 200)));
  const parMs = performance.now() - t4;

  return {
    n,
    environment: "LAB / single-process / no-network",
    intakeMs,
    batchingMs,
    conflictMs,
    sequentialExecMs: seqMs,
    parallelExecMs: parMs,
    waveCount: waves.length,
    seqCommitment: seq.snapshot.commitment,
    parCommitment: par.snapshot.commitment,
    commitmentsMatch: seq.snapshot.commitment === par.snapshot.commitment,
    note: "Execution sample capped at 200 TX for wall-time; intake/batching full n",
  };
}

async function main() {
  const results = [];
  for (const n of [100, 1000, 10000]) {
    results.push(await bench(n));
  }
  mkdirSync(new URL("../../uep-core/benchmarks", import.meta.url).pathname, { recursive: true });
  const path =
    new URL("../../uep-core/benchmarks/uep35.5-bench.json", import.meta.url).pathname;
  writeFileSync(path, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log("wrote", path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
