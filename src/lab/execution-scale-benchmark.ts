/**
 * UEP-30.1 — measure wall time vs proveConcurrency (structural or ZK).
 *
 * Usage:
 *   node --experimental-strip-types \
 *     src/core/execution-scale-benchmark.ts [--prove] [--depth=4] [--tx=4]
 */
import { Fr } from "../core/field.ts";
import { ExecutionEngine } from "./execution-engine.ts";
import { findUepZkBinary } from "./zk-bridge.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const prove = process.argv.includes("--prove");
const depth = process.argv.includes("--depth=32") ? 32 : 4;
const txArg = process.argv.find((a) => a.startsWith("--tx="));
const txCount = txArg ? Number(txArg.split("=")[1]) : prove ? 4 : 32;
const concArg = process.argv.find((a) => a.startsWith("--concurrency="));
const concurrencies = concArg
  ? [Number(concArg.split("=")[1])]
  : prove
    ? [1, 2]
    : [1, 2, 4, 8];

if (prove && !findUepZkBinary()) {
  console.error("uep-zk binary required for --prove");
  process.exit(1);
}

type Row = {
  concurrency: number;
  txCount: number;
  wallMs: number;
  txPerSec: number;
  committed: number;
};

const rows: Row[] = [];

for (const c of concurrencies) {
  const eng = new ExecutionEngine({
    depth: depth as 4 | 32,
    profile: "local",
    requireProof: prove,
    proveConcurrency: c,
    oneInFlightPerSender: true,
    seedBase: 500 + c,
  });
  for (let i = 0; i < txCount; i++) {
    eng.registerAccount(`s${i}`, {
      secret: Fr.from(BigInt(1000 + i)),
      salt: Fr.from(BigInt(2000 + i)),
      blinding: Fr.from(BigInt(3 + (i % 7))),
      balance: 100_000n,
    });
    eng.registerAccount(`r${i}`, {
      secret: Fr.from(BigInt(3000 + i)),
      salt: Fr.from(BigInt(4000 + i)),
      blinding: Fr.from(BigInt(4 + (i % 5))),
      balance: 0n,
    });
    const e = eng.enqueue({
      id: `tx-${c}-${i}`,
      from: `s${i}`,
      to: `r${i}`,
      amount: 1000n,
    });
    if (!e.ok) throw new Error((e as { error: string }).error);
  }
  const t0 = performance.now();
  const { commits, failed } = await eng.runRound();
  const wallMs = performance.now() - t0;
  if (failed.length) console.error("failed", failed);
  const committed = commits.filter((x) => x.ok).length;
  rows.push({
    concurrency: c,
    txCount,
    wallMs,
    txPerSec: committed / (wallMs / 1000),
    committed,
  });
  console.log(
    JSON.stringify(rows[rows.length - 1]),
  );
}

const report = {
  version: "UEP-30.1",
  requireProof: prove,
  depth,
  environment: {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    uepZk: findUepZkBinary(),
  },
  rows,
  note: prove
    ? "Ideal TX/s ≈ concurrency / prove_seconds when no conflicts and enough RAM/CPU"
    : "Structural path — measures orchestration overhead, not Groth16",
};

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../artifacts/uep-30.1-evidence",
);
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(
  outDir,
  `scale-${prove ? "prove" : "struct"}-d${depth}-tx${txCount}-c${concurrencies.join("-")}.json`,
);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log("wrote", out);
