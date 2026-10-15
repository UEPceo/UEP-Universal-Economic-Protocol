#!/usr/bin/env node
/**
 * 0.5.83 Block E: run the given npm scripts ONE AT A TIME (never in parallel) and record
 * reproducible evidence: command, Node version, platform, commit, seeds (from the seeded
 * runner record), exit code, duration, the full output (saved to a file) and its SHA-256.
 * Usage: node scripts/run-evidence.mjs --out docs/audit/evidence-0.5.83 test:security test:property:full
 */
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = join(root, outIdx >= 0 ? args[outIdx + 1] : "docs/audit/evidence");
const scripts = args.filter((a, i) => a !== "--out" && i !== outIdx + 1);
mkdirSync(out, { recursive: true });
let commit = "unknown";
try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
const major = process.versions.node.split(".")[0];
const record = { schema: "uep-evidence-run-v1", commit, node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, runs: [] };
for (const s of scripts) {
  const t0 = Date.now();
  const r = spawnSync("npm", ["run", "-s", s], { cwd: root, encoding: "utf8", env: { ...process.env }, maxBuffer: 1 << 28 });
  const text = (r.stdout ?? "") + (r.stderr ?? "");
  const file = `${s.replace(/[:/]/g, "_")}-node${major}.log`;
  writeFileSync(join(out, file), text);
  const num = (k) => [...text.matchAll(new RegExp(`^(?:ℹ|#) ${k} (\\d+)`, "gm"))].reduce((a, m) => a + Number(m[1]), 0);
  record.runs.push({ command: `npm run ${s}`, exitCode: r.status, ms: Date.now() - t0, pass: num("pass"), fail: num("fail"), output: file, sha256: createHash("sha256").update(text).digest("hex") });
  console.log(`${r.status === 0 ? "ok  " : "FAIL"} npm run ${s} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
const seeded = join(root, "artifacts", "test-runs");
if (existsSync(seeded)) record.seededRuns = readdirSync(seeded).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(seeded, f), "utf8"))).filter((x) => x.commit === commit);
writeFileSync(join(out, `record-node${major}.json`), JSON.stringify(record, null, 2) + "\n");
process.exit(record.runs.every((r) => r.exitCode === 0) ? 0 : 1);
