/**
 * UEP-35.6.2 reproducible benchmark — LAB / single-process only.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import type { BatchTx } from "./uep35-batch-lab.ts";
import {
  partitionByConflictGraphLegacy,
  partitionByConflictGraphIndexed,
  countConflictEdgesIndexed,
  validateWaves,
} from "./uep35-conflict-graph.ts";
import { buildTopology, floodProbe } from "./uep-net-adapt/topology-sim.ts";

const BENCH_VERSION = "35.6.2";
const SEED = 20260928;

function makeTxs(n: number, accounts: number, seed: number): BatchTx[] {
  const txs: BatchTx[] = [];
  for (let i = 0; i < n; i++) {
    const from = (i + seed) % accounts;
    let to = (i * 7 + 3 + seed) % accounts;
    if (to === from) to = (to + 1) % accounts;
    txs.push({ id: `t-${seed}-${i}`, from: `a${from}`, to: `a${to}`, amount: 1n });
  }
  return txs;
}

async function main() {
  const scheduler = [];
  for (const n of [100, 1000, 10000, 50000]) {
    const accounts = Math.min(100, Math.max(8, Math.floor(Math.sqrt(n))));
    const txs = makeTxs(n, accounts, SEED);
    let legacyMs: number | null = null;
    if (n <= 10000) {
      const t0 = performance.now();
      const leg = partitionByConflictGraphLegacy(txs);
      legacyMs = performance.now() - t0;
      if (!validateWaves(txs, leg).ok) throw new Error("legacy invalid");
    }
    const t1 = performance.now();
    const waves = partitionByConflictGraphIndexed(txs);
    const indexedMs = performance.now() - t1;
    if (!validateWaves(txs, waves).ok) throw new Error("indexed invalid");
    const edges =
      n <= 20000 ? countConflictEdgesIndexed(txs) : null;
    scheduler.push({
      n,
      environment: "LAB / single-process / no-network",
      seed: SEED,
      wallClockMs: {
        legacy: legacyMs,
        indexed: indexedMs,
      },
      simulationTimeMs: null,
      waveCount: waves.length,
      maxWave: waves.reduce((m, w) => Math.max(m, w.length), 0),
      conflictEdgesIndexed: edges,
      speedup:
        legacyMs && legacyMs > 0
          ? legacyMs / Math.max(indexedMs, 0.001)
          : null,
    });
  }

  const network = [];
  for (const n of [10, 50, 100]) {
    const nodes = buildTopology(n);
    const t0 = performance.now();
    const r = await floodProbe(nodes);
    network.push({
      nodes: n,
      environment: "LAB / simulated topology",
      wallClockMs: performance.now() - t0,
      ...r,
    });
  }

  let pkgVersion = "unknown";
  try {
    if (existsSync("package.json")) {
      pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version ?? "unknown";
    }
  } catch {
    /* ignore */
  }

  const out = {
    benchmarkVersion: BENCH_VERSION,
    packageVersion: pkgVersion,
    seed: SEED,
    generatedAtIso: new Date().toISOString(),
    note:
      "LAB only — not network TPS. conflictEdgesIndexed = real undirected pairs. wallClock ≠ simulation time.",
    scheduler,
    network,
  };
  mkdirSync(new URL("../../uep-core/benchmarks", import.meta.url).pathname, {
    recursive: true,
  });
  const path =
    new URL("../../uep-core/benchmarks/uep35.6-bench.json", import.meta.url).pathname;
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main();
