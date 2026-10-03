#!/usr/bin/env node
/**
 * Runs the research/lab suites: src/lab (consensus, ZK bridge, execution engine,
 * economic labs), src/agent and the service/API layer lab in src/service.
 *
 * Each test file runs in its own `node --test` process, one at a time, because
 * several suites start real OS processes and TCP meshes.
 *
 * Files listed in scripts/lab-known-issues.json are skipped by default and
 * reported; run with --include-known to execute them too, or --only-known to run
 * just those files (the non-blocking CI job does this).
 *
 * The ZK suites need the `uep-zk` helper. If UEP_ZK_BIN is unset and
 * uep-core/target/release/uep-zk exists, it is used; otherwise run
 * `npm run build:uep-zk` first (test:all does this).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onlyKnown = process.argv.includes("--only-known");
const includeKnown = onlyKnown || process.argv.includes("--include-known");
const only = process.argv.filter((a) => !a.startsWith("--")).slice(2);
const known = JSON.parse(fs.readFileSync(path.join(root, "scripts/lab-known-issues.json"), "utf8"));
const knownMap = new Map(known.files.map((k) => [k.file, k.reason]));

const targetDir = process.env.CARGO_TARGET_DIR || path.join(root, "uep-core/target");
const builtZk = path.join(targetDir, "release/uep-zk");
const env = { ...process.env };
if (!env.UEP_ZK_BIN && fs.existsSync(builtZk)) env.UEP_ZK_BIN = builtZk;
if (!env.UEP_ZK_BIN) {
  console.error("uep-zk not found: run `npm run build:uep-zk` (or set UEP_ZK_BIN).");
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel));
    else if (e.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

// src/service: only the service/API layer lab. iot-m2m.test.ts, iot-mars-delay.test.ts, compat-shims.test.ts and
// uep-http-authz.test.ts already run in `npm test`.
const serviceLab = (f) => !f.endsWith("/iot-m2m.test.ts") && !f.endsWith("/iot-mars-delay.test.ts") && !f.endsWith("/compat-shims.test.ts") && !f.endsWith("/uep-http-authz.test.ts") && !f.endsWith("/height-producer.test.ts") && !f.endsWith("/poisoned-clock.test.ts");
let files = [...walk("src/lab"), ...walk("src/agent"), ...walk("src/service").filter(serviceLab)].sort();
if (only.length) files = files.filter((f) => only.some((o) => f.includes(o)));
if (onlyKnown) files = files.filter((f) => knownMap.has(f));

let passed = 0;
let failed = 0;
const failures = [];
const skipped = [];
const t0 = Date.now();
for (const f of files) {
  if (knownMap.has(f) && !includeKnown) {
    skipped.push(f);
    continue;
  }
  const s = Date.now();
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", "--test-reporter=tap", "--test-force-exit", "--test-timeout=240000", f],
    { cwd: root, env, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const p = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0);
  const fl = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0);
  passed += p;
  failed += fl;
  const ok = r.status === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${f} (${p} pass, ${fl} fail, ${((Date.now() - s) / 1000).toFixed(1)}s)`);
  if (!ok) {
    failures.push(f);
    console.log(out.split("\n").filter((l) => /not ok|error:|Error/.test(l)).slice(0, 20).join("\n"));
  }
}
console.log(`\nlab suites: ${files.length - skipped.length} files, ${passed} tests passed, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (skipped.length) {
  console.log(`known issues skipped (${skipped.length}), see scripts/lab-known-issues.json:`);
  for (const f of skipped) console.log(`  - ${f}: ${knownMap.get(f)}`);
}
if (failures.length) {
  console.log(`failing files:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
