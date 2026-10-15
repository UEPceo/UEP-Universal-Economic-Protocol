#!/usr/bin/env node
// 0.5.82 (Research fix 7): source adapters live in scripts/adapters/ and run off-node
// (by attesters). Nothing under src/ may import them. Fails with exit 1 if it does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const offenders = [];
const IMPORT = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(ts|mts|js|mjs|cjs)$/.test(name)) continue;
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? "";
      if (/(^|\/)scripts\/adapters(\/|$)/.test(spec) || /(^|\/)adapters\/[^/]*$/.test(spec) && spec.includes("scripts")) offenders.push(`${p}: ${spec}`);
    }
  }
}
walk("src");
if (offenders.length) {
  console.error(`check-adapter-imports: src/ must not import scripts/adapters (external sources stay off-node):\n  ${offenders.join("\n  ")}`);
  process.exit(1);
}
console.log("check-adapter-imports: no src/ import of scripts/adapters");
