/**
 * UEP-36.1.2 LAB metrics — real phase timings (not variable reads).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildDigestAggregate } from "./uep36-digest-agg.ts";
import { parallelSafeScheduleApply } from "./uep36-parallel-exec.ts";
import { partitionByConflictGraph } from "./uep35-conflict-graph.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";

function makeTxs(n: number, seed: number): BatchTx[] {
  const out: BatchTx[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `b3612-s${seed}-t${i}`,
      from: `s${i % 8}`,
      to: `r${(i * 3) % 8}`,
      amount: BigInt(1 + (i % 5)),
    });
  }
  return out;
}

export function runBench3612(opts?: { seed?: number; txCount?: number }) {
  const seed = opts?.seed ?? 3612;
  const txCount = opts?.txCount ?? 200;
  const txs = makeTxs(txCount, seed);
  const initial: Record<string, bigint> = {};
  for (let i = 0; i < 8; i++) {
    initial[`s${i}`] = 100_000n;
    initial[`r${i}`] = 0n;
  }

  const entries = txs.slice(0, 50).map((t) => ({
    batchId: `batch-${t.id}`,
    txDigest: t.id,
  }));

  const t0 = performance.now();
  const agg = buildDigestAggregate(0, 1, "GENESIS", entries);
  const digestAggregationMs = performance.now() - t0;

  const t1 = performance.now();
  const waves = partitionByConflictGraph(txs);
  const conflictAnalysisMs = performance.now() - t1;

  const state = new LocalEconomicState(initial);

  const t2 = performance.now();
  const seq = state.clone();
  const seqR = seq.applyBatch(txs);
  if (!seqR.ok) throw new Error(seqR.reason);
  const sequentialExecutionMs = performance.now() - t2;
  const sequentialRoot = seqR.stateRoot;

  const t3 = performance.now();
  for (const w of waves) {
    if (w.length) {
      const r = state.applyTransfers(w);
      if (!r.ok) throw new Error(r.reason);
    }
  }
  const scheduledExecutionMs = performance.now() - t3;

  const t4 = performance.now();
  const scheduledRoot = state.commitLogicalHeight();
  const stateRootComputationMs = performance.now() - t4;

  return {
    version: "36.1.2",
    seed,
    transactions: txCount,
    waves: waves.length,
    digestAggregationMs,
    conflictAnalysisMs,
    sequentialExecutionMs,
    scheduledExecutionMs,
    stateRootComputationMs,
    sequentialRoot,
    scheduledRoot,
    aggregateDigest: agg.aggregateDigest,
    rootsMatch: sequentialRoot === scheduledRoot,
    heightsEqual: seq.sequence === state.sequence,
    note: "LAB only; scheduled path is sequential waves, not concurrent",
  };
}

if (process.argv[1]?.includes("uep36.1.2-benchmark")) {
  const result = runBench3612();
  const dir = join(process.cwd(), "uep-core", "benchmarks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "uep36.1.2-bench.json");
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  console.log("wrote", path);
}
