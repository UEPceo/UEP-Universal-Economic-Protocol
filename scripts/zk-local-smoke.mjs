#!/usr/bin/env node
/**
 * Build (if needed) + run uep-zk demo-d4. Optional D=32 with --d32.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crate = path.join(root, "uep-core/uep-26-spend-circuit");
const bin = process.env.UEP_ZK_BIN || path.join(root, "uep-core/target/release/uep-zk");
const d32 = process.argv.includes("--d32");

function run(cmd, args, opts = {}) {
  console.log(">", cmd, args.join(" "));
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd || root, env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!fs.existsSync(bin)) {
  console.log("Building uep-zk (--release)...");
  run("bash", [path.join(root, "scripts/build-uep-zk.sh")]);
}

run(bin, ["circuit-id"]);
run(bin, ["public-schema"]);
run(bin, [d32 ? "demo-d32" : "demo-d4"]);
console.log("ZK LOCAL SMOKE OK");
