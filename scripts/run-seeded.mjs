#!/usr/bin/env node
/**
 * 0.5.81 item 10: run the seeded property / fault suites over a fixed seed list and record
 * seeds, environment, commit and results as JSON (artifacts/test-runs/<commit>-node<major>.json).
 * Usage: node scripts/run-seeded.mjs [--seeds 20261015,1,7] [--include-multiprocess]
 * Exit code is non-zero if any run failed; the JSON is written either way.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const seeds = (arg("--seeds") ?? "20261015,1,7,42,2026,31337").split(",").map((s) => Number(s));
const suites = [
  { name: "marketplace-state-machine", file: "src/property/marketplace-state-machine.property.test.ts", env: "UEP_MKT_SEED" },
  { name: "numeric-amounts", file: "src/property/amount.property.test.ts", env: "UEP_NUM_SEED" },
];
if (process.argv.includes("--include-multiprocess")) {
  suites.push({ name: "bft-multiprocess", file: "src/node/bft-multiprocess.test.ts", env: "UEP_BFT_FAULT_SEED" });
  // 0.5.83 Blocks B and C (separate OS processes, fault-injecting proxies, SIGKILL + restart). First three seeds (run time).
  suites.push({ name: "bft-recovery-multiprocess", file: "src/node/bft-recovery-multiprocess.test.ts", env: "UEP_BFT_FAULT_SEED", maxSeeds: 3 });
  suites.push({ name: "bft-crash-points-multiprocess", file: "src/node/bft-crash-points-multiprocess.test.ts", env: "UEP_BFT_FAULT_SEED", maxSeeds: 3 });
}

let commit = "unknown";
try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { /* not a git checkout */ }
const record = {
  schema: "uep-seeded-run-v1", commit,
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, ci: Boolean(process.env.CI) },
  startedAt: new Date().toISOString(), runs: [],
};
let failed = 0;
for (const suite of suites) for (const seed of seeds.slice(0, suite.maxSeeds ?? seeds.length)) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--test", suite.file], { cwd: root, env: { ...process.env, [suite.env]: String(seed) }, encoding: "utf8", timeout: 900_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const num = (k) => Number((new RegExp(`^(?:ℹ|#) ${k} (\\d+)`, "m").exec(out) ?? [])[1] ?? NaN);
  const ok = r.status === 0;
  if (!ok) failed++;
  const failures = ok ? [] : out.split("\n").filter((l) => /^(✖ |not ok )/.test(l)).slice(0, 20);
  record.runs.push({ suite: suite.name, file: suite.file, seedEnv: suite.env, seed, ok, pass: num("pass"), fail: num("fail"), ms: Date.now() - t0, failures, reproduce: `${suite.env}=${seed} node --experimental-strip-types --test ${suite.file}` });
  console.log(`${ok ? "ok  " : "FAIL"} ${suite.name} seed=${seed} pass=${num("pass")} fail=${num("fail")}`);
}
record.finishedAt = new Date().toISOString();
record.summary = { runs: record.runs.length, failed };
const dir = join(root, "artifacts", "test-runs");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${commit.slice(0, 12)}-node${process.versions.node.split(".")[0]}.json`);
writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
console.log(`seeded runs: ${record.runs.length}, failed: ${failed}; record: ${file}`);
process.exit(failed ? 1 : 0);
