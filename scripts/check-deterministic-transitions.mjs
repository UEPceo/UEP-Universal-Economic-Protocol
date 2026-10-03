#!/usr/bin/env node
/**
 * Determinism lint for state transitions (docs/adr/0002-deterministic-transitions.md).
 *
 * Fails if code on the transition paths reads the wall clock or can reach an
 * external system: fetch(, Date.now, new Date(, Date() as a call,
 * performance.now, process.hrtime, timers, or imports of network / file /
 * process modules (http, https, http2, net, tls, dgram, dns, fs, child_process,
 * worker_threads, perf_hooks). Comments and string literals are ignored.
 *
 * Scanned paths: src/core, src/testnet, src/marketplace (including tests and
 * testkits), src/network and the IoT / M2M service files. Exceptions are the
 * ALLOWLIST below; each entry names a file, the rule it may break and why.
 * An allowlist entry that no longer matches anything also fails the check.
 *
 * Usage: node scripts/check-deterministic-transitions.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories scanned recursively (relative to the repository root). */
export const SCANNED_DIRS = ["src/core", "src/testnet", "src/marketplace", "src/network"];
/** Single files scanned (IoT / M2M category service and the helpers deliver() uses). */
export const SCANNED_FILES = ["src/service/iot-m2m.ts", "src/service/iot-m2m-codec.ts", "src/service/iot-testkit.ts", "src/service/content-hash.ts"];

const FORBIDDEN_MODULES = ["http", "https", "http2", "net", "tls", "dgram", "dns", "dns/promises", "fs", "fs/promises", "child_process", "worker_threads", "perf_hooks", "readline", "inspector"];
const moduleAlternation = FORBIDDEN_MODULES.map((m) => m.replace("/", "\\/")).join("|");

/** Rules: id, pattern (applied to code with comments and strings blanked), message. */
export const RULES = [
  { id: "fetch", re: /(?<![\w$.])fetch\s*\(/g, message: "external call (fetch)" },
  { id: "date-now", re: /\bDate\s*\.\s*now\b/g, message: "wall clock (Date.now)" },
  { id: "new-date", re: /\bnew\s+Date\b/g, message: "wall clock (new Date)" },
  { id: "date-call", re: /(?<![\w$.])Date\s*\(\s*\)/g, message: "wall clock (Date())" },
  { id: "performance-now", re: /\bperformance\s*\.\s*now\b/g, message: "wall clock (performance.now)" },
  { id: "hrtime", re: /\bprocess\s*\.\s*hrtime\b/g, message: "wall clock (process.hrtime)" },
  { id: "timer", re: /(?<![\w$.])(setTimeout|setInterval|setImmediate)\s*\(/g, message: "timer (setTimeout / setInterval / setImmediate)" },
  { id: "net-import", re: new RegExp(`\\b(?:from|import|require)\\s*\\(?\\s*["'\`](?:node:)?(?:${moduleAlternation})["'\`]`, "g"), message: "network / file / process module import" },
];

/**
 * Allowed exceptions. `file` is relative to the repo root, `rule` is a rule id.
 * Keep this list short; every entry needs a reason.
 */
export const ALLOWLIST = [
  {
    file: "src/marketplace/listing-index.test.ts",
    rule: "performance-now",
    reason: "Test-only timing of the listing index benchmark; the measured duration is asserted by the test and never reaches a transition.",
  },
  {
    file: "src/core/poseidon.test.ts",
    rule: "net-import",
    reason: "Test-only node:fs read of the committed, hash-pinned Poseidon vectors (uep-core/vectors); static repository data, not live data.",
  },
];

/** Replace comments and string / template literal contents with spaces (keeps offsets and line numbers). */
export function blankCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  const keepNewlines = (s) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
    } else if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      // Keep the quotes and module-like specifiers of import / require so the import rule still sees them.
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      const literal = src.slice(i, Math.min(j + 1, n));
      const before = src.slice(Math.max(0, i - 40), i);
      const isSpecifier = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*$/.test(before);
      out += isSpecifier ? literal : c + keepNewlines(literal.slice(1, -1)) + (literal.length > 1 ? c : "");
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Violations of one source text: [{ rule, line, text, message }]. */
export function scanSource(src) {
  const code = blankCommentsAndStrings(src);
  const lines = src.split("\n");
  const found = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(code)) !== null) {
      const line = code.slice(0, m.index).split("\n").length;
      found.push({ rule: rule.id, line, text: (lines[line - 1] ?? "").trim(), message: rule.message });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function walk(dir, files) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(name)) files.push(full);
  }
}

/** Files on the scanned paths, relative to `root`, with forward slashes. */
export function scannedFiles(root = ROOT) {
  const files = [];
  for (const d of SCANNED_DIRS) walk(join(root, d), files);
  for (const f of SCANNED_FILES) files.push(join(root, f));
  return [...new Set(files.map((f) => relative(root, f).split(sep).join("/")))].sort();
}

/**
 * Scan the repository. Returns { violations, allowed, staleAllowlist, files }.
 * `overrides` maps a relative path to replacement source (used by tests).
 */
export function checkRepository(root = ROOT, overrides = {}) {
  const files = scannedFiles(root);
  const violations = [];
  const allowed = [];
  const used = new Set();
  for (const file of files) {
    const src = overrides[file] ?? readFileSync(join(root, file), "utf8");
    for (const v of scanSource(src)) {
      const entry = ALLOWLIST.findIndex((a) => a.file === file && a.rule === v.rule);
      if (entry >= 0) {
        used.add(entry);
        allowed.push({ file, ...v });
      } else {
        violations.push({ file, ...v });
      }
    }
  }
  const staleAllowlist = ALLOWLIST.filter((_, i) => !used.has(i));
  return { violations, allowed, staleAllowlist, files };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const result = checkRepository();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const v of result.violations) console.error(`${v.file}:${v.line}: ${v.message} [${v.rule}]\n    ${v.text}`);
    for (const a of result.staleAllowlist) console.error(`allowlist entry no longer needed: ${a.file} [${a.rule}]`);
    console.log(`deterministic-transitions: ${result.files.length} files scanned, ${result.violations.length} violation(s), ${result.allowed.length} allowlisted, ${result.staleAllowlist.length} stale allowlist entr${result.staleAllowlist.length === 1 ? "y" : "ies"}`);
  }
  process.exitCode = result.violations.length > 0 || result.staleAllowlist.length > 0 ? 1 : 0;
}
