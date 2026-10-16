#!/usr/bin/env node
/**
 * 0.5.84 item 4: run npm suites one after another and write an evidence record tied to the exact
 * commit SHA (git rev-parse HEAD), with the working-tree state, Node version, per-suite exit code,
 * duration, test counts parsed from the TAP summary and the SHA-256 of each full log.
 *
 *   node scripts/run-evidence.mjs --out <dir> [--env K=V] <npm-script> [<npm-script> ...]
 *
 * Writes <dir>/evidence-<shortsha>-node<major>.json and <dir>/logs/<script>.log. Exits non-zero
 * if any suite fails. A record from a dirty tree is marked "dirty": true and must not be cited
 * as evidence for that commit.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
let out = "artifacts/evidence";
const env = { ...process.env };
const suites = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = args[++i];
  else if (args[i] === "--env") { const [k, ...v] = args[++i].split("="); env[k] = v.join("="); }
  else suites.push(args[i]);
}
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no").length > 0;
mkdirSync(join(out, "logs"), { recursive: true });
const record = {
  format: "uep-evidence", version: 1, commit, dirty,
  node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length,
  ci: process.env.GITHUB_ACTIONS === "true" ? { runId: process.env.GITHUB_RUN_ID, workflow: process.env.GITHUB_WORKFLOW, job: process.env.GITHUB_JOB, sha: process.env.GITHUB_SHA } : null,
  env: Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("UEP_"))),
  startedAt: new Date().toISOString(), suites: [],
};
let failed = false;
for (const s of suites) {
  const t0 = Date.now();
  const r = spawnSync("npm", ["run", "-s", s], { env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const log = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const file = join(out, "logs", `${s.replace(/[^a-z0-9:_-]/gi, "_")}.log`);
  writeFileSync(file, log);
  const count = (k) => [...log.matchAll(new RegExp(`^ℹ ${k} (\\d+)`, "gm"))].reduce((a, m) => a + Number(m[1]), 0);
  const entry = { suite: s, exitCode: r.status, signal: r.signal, durationMs: Date.now() - t0, tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), logSha256: createHash("sha256").update(log).digest("hex"), log: file };
  record.suites.push(entry);
  console.log(`[evidence] ${s}: exit=${r.status} ${entry.pass}/${entry.tests} pass, ${entry.fail} fail, ${Math.round(entry.durationMs / 1000)} s`);
  if (r.status !== 0) failed = true;
}
record.finishedAt = new Date().toISOString();
record.ok = !failed;
const name = join(out, `evidence-${commit.slice(0, 12)}-node${process.versions.node.split(".")[0]}.json`);
writeFileSync(name, JSON.stringify(record, null, 2) + "\n");
console.log(`[evidence] wrote ${name} (commit ${commit}${dirty ? ", DIRTY tree" : ""})`);
process.exit(failed ? 1 : 0);
