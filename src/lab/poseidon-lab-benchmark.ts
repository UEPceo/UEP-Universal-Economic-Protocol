/**
 * UEP-29.4 benchmark — REAL phase timings from uep-zk CLI (no 95/5 split).
 *
 * Phases reported per TX when requireProof:
 *   setup_ms, prove_ms, verify_ms  (from Rust)
 *   apply_ms                       (lab bookkeeping after proof)
 *   total_ms                       (wall clock in TS)
 */

import { Fr } from "../core/field.ts";
import { PoseidonLabEngine, type LabTxResult } from "./poseidon-lab-engine.ts";
import { findUepZkBinary } from "./zk-bridge.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

export type BenchmarkReport = {
  version: string;
  depth: 4 | 32;
  requireProof: boolean;
  txCount: number;
  okCount: number;
  failCount: number;
  totalWallMs: number;
  txPerSec: number;
  phases: {
    setupMs: number[];
    proveMs: number[];
    verifyMs: number[];
    applyMs: number[];
    totalMs: number[];
  };
  averages: {
    setupMs: number;
    proveMs: number;
    verifyMs: number;
    applyMs: number;
    totalMs: number;
  };
  vkIds: string[];
  environment: {
    platform: string;
    arch: string;
    cpus: number;
    totalMemMb: number;
    node: string;
    uepZkBinary: string | null;
  };
  note: string;
};

function avg(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function runLabBenchmark(opts: {
  depth: 4 | 32;
  txCount: number;
  requireProof: boolean;
}): BenchmarkReport {
  if (opts.requireProof && !findUepZkBinary()) {
    throw new Error("uep-zk binary required for --prove benchmark");
  }

  const engine = new PoseidonLabEngine({
    depth: opts.depth,
    networkId: "uep-poseidon-lab-1",
    domainId: "LAB",
    profile: "local",
    requireProof: opts.requireProof,
    seedBase: 100,
  });

  engine.registerAccount("alice", {
    secret: Fr.from(11n),
    salt: Fr.from(22n),
    blinding: Fr.from(3n),
    balance: 1_000_000n,
  });
  engine.registerAccount("bob", {
    secret: Fr.from(33n),
    salt: Fr.from(44n),
    blinding: Fr.from(4n),
    balance: 0n,
  });

  const results: LabTxResult[] = [];
  const t0 = performance.now();
  for (let i = 0; i < opts.txCount; i++) {
    results.push(engine.spend("alice", "bob", 1000n, i));
  }
  const totalWallMs = performance.now() - t0;
  const ok = results.filter((r) => r.ok);
  const setupMs = ok.map((r) => r.setupMs ?? 0);
  const proveMs = ok.map((r) => r.proveMs ?? 0);
  const verifyMs = ok.map((r) => r.verifyMs ?? 0);
  const applyMs = ok.map((r) => r.applyMs ?? 0);
  const totalMs = ok.map((r) => r.totalMs ?? 0);

  const report: BenchmarkReport = {
    version: "UEP-29.4",
    depth: opts.depth,
    requireProof: opts.requireProof,
    txCount: opts.txCount,
    okCount: ok.length,
    failCount: results.length - ok.length,
    totalWallMs,
    txPerSec: ok.length / (totalWallMs / 1000),
    phases: { setupMs, proveMs, verifyMs, applyMs, totalMs },
    averages: {
      setupMs: avg(setupMs),
      proveMs: avg(proveMs),
      verifyMs: avg(verifyMs),
      applyMs: avg(applyMs),
      totalMs: avg(totalMs),
    },
    vkIds: [...new Set(ok.map((r) => r.vkId).filter(Boolean) as string[])],
    environment: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      node: process.version,
      uepZkBinary: findUepZkBinary(),
    },
    note: opts.requireProof
      ? "setup/prove/verify from Rust CLI clocks; apply = lab bookkeeping after verify-hex"
      : "structural only — no Groth16; timings are apply/total only",
  };
  return report;
}

export function writeBenchmarkReport(report: BenchmarkReport, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
}

// CLI: node --experimental-strip-types ... poseidon-lab-benchmark.ts --prove --depth=4 --tx=3
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const prove = process.argv.includes("--prove");
  const depth = process.argv.includes("--depth=32") ? 32 : 4;
  const txArg = process.argv.find((a) => a.startsWith("--tx="));
  const txCount = txArg ? Number(txArg.split("=")[1]) : prove ? (depth === 32 ? 2 : 3) : 20;
  const report = runLabBenchmark({
    depth: depth as 4 | 32,
    txCount,
    requireProof: prove,
  });
  console.log(JSON.stringify(report, null, 2));
  const out = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    `../../artifacts/benchmark-d${depth}-${prove ? "prove" : "struct"}-tx${txCount}.json`,
  );
  writeBenchmarkReport(report, out);
  console.log("wrote", out);
}
