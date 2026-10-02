/**
 * UEP-36.1.1 LAB metrics — not production TPS.
 * Separates digest / conflict / schedule / stateRoot times.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildDigestAggregate,
  computeAggregateDigest,
} from "./uep36-digest-agg.ts";
import { parallelSafeScheduleApply } from "./uep36-parallel-exec.ts";
import { partitionByConflictGraph } from "./uep35-conflict-graph.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";

function makeTxs(n: number, seed: number): BatchTx[] {
  const out: BatchTx[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `bench-s${seed}-t${i}`,
      from: `s${i % 8}`,
      to: `r${(i * 3) % 8}`,
      amount: BigInt(1 + (i % 5)),
    });
  }
  return out;
}

export function runBench3611(opts?: { seed?: number; txCount?: number }) {
  const seed = opts?.seed ?? 3611;
  const txCount = opts?.txCount ?? 200;
  const txs = makeTxs(txCount, seed);
  const initial: Record<string, bigint> = {};
  for (let i = 0; i < 8; i++) {
    initial[`s${i}`] = 100_000n;
    initial[`r${i}`] = 0n;
  }

  const t0 = performance.now();
  const entries = txs.map((t) => ({
    batchId: `batch-${t.id}`,
    txDigest: t.id,
  }));
  // unique batchIds already
  const agg = buildDigestAggregate(0, 1, "GENESIS", entries.slice(0, 50));
  const digestMs = performance.now() - t0;

  const t1 = performance.now();
  const waves = partitionByConflictGraph(txs);
  const conflictMs = performance.now() - t1;

  const state = new LocalEconomicState(initial);
  const t2 = performance.now();
  const sched = parallelSafeScheduleApply(state, txs);
  const scheduleExecMs = performance.now() - t2;

  const t3 = performance.now();
  const root = sched.scheduledRoot;
  const rootMs = performance.now() - t3;

  return {
    version: "36.1.1",
    seed,
    nodes: 0,
    batches: 50,
    transactions: txCount,
    waves: sched.waveCount,
    conflictsImplied: sched.waveCount > 1,
    digestAggregationMs: digestMs,
    conflictAnalysisMs: conflictMs,
    waveConstructionIncludedInConflictMs: true,
    parallelSafeSchedulingMs: scheduleExecMs,
    stateRootMs: rootMs,
    rootsMatch: sched.rootsMatch,
    sampleAggregateDigest: agg.aggregateDigest.slice(0, 16),
    sampleStateRoot: root.slice(0, 16),
    note: "LAB metrics only — not production TPS; scheduling is sequential waves",
  };
}

if (process.argv[1]?.includes("uep36.1.1-benchmark")) {
  const result = runBench3611();
  const dir = join(process.cwd(), "uep-core", "benchmarks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "uep36.1.1-bench.json");
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  console.log("wrote", path);
}
