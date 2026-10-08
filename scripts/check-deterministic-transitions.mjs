#!/usr/bin/env node
/**
 * Determinism lint for state transitions (docs/adr/0002-deterministic-transitions.md).
 *
 * Fails if code on the transition paths reads the wall clock, uses
 * randomness or can reach an external system: fetch (also aliased or through
 * globalThis / self), Date (Date.now, new Date, Date(), any alias), performance,
 * process.hrtime / uptime / env / getBuiltinModule / process[...], timers and
 * queueMicrotask, Math.random and crypto random / key generation,
 * XMLHttpRequest / WebSocket / EventSource / createRequire / Intl, eval and
 * new Function, import() / require() with a computed specifier, and imports
 * of network / file / process / timer / loader modules (http, https, http2,
 * net, tls, dgram, dns, fs, child_process, worker_threads, perf_hooks,
 * readline, inspector, timers, os, module, vm, cluster, repl, undici).
 * Transition code may only import files on the scanned paths and the node
 * builtins in ALLOWED_NODE_MODULES (import closure, checked per statement):
 * npm (bare) specifiers, file: URLs, absolute paths, #subpath imports and
 * template-literal specifiers are violations. Comments and string literals
 * are ignored.
 *
 * This lint is a GUARD, NOT A SANDBOX. It is a set of regular expressions
 * over source text: it catches accidents and the evasions we know of, not a
 * determined contributor (code reached through a value captured before the
 * check, through eval-free reflection, or in a dependency it cannot see). The
 * runtime poisoned-clock suite (src/service/poisoned-clock.test.ts,
 * npm run test:poisoned-clock) is the second guard; neither is a proof.
 *
 * Scanned paths: src/core, src/testnet, src/marketplace (including tests and
 * testkits), src/network, src/settlement, src/category, src/oracle (v0.5.2)
 * and the IoT / M2M service files. Exceptions are the
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
/** v0.5.2: the settlement engine, the category modules and the oracle layer are scanned too. */
export const SCANNED_DIRS = ["src/core", "src/testnet", "src/marketplace", "src/network", "src/settlement", "src/category", "src/oracle"];
/** Single files scanned (IoT / M2M category service and the helpers deliver() uses). */
export const SCANNED_FILES = ["src/service/iot-m2m.ts", "src/service/iot-m2m-codec.ts", "src/service/iot-testkit.ts", "src/service/content-hash.ts"];

const FORBIDDEN_MODULES = [
  "http", "https", "http2", "net", "tls", "dgram", "dns", "dns/promises", "fs", "fs/promises", "child_process", "worker_threads", "perf_hooks", "readline", "inspector",
  // v0.5.1 hardening (review of the first version): timers, OS state, module loaders and network clients.
  "timers", "timers/promises", "os", "module", "vm", "cluster", "repl", "undici",
];
const moduleAlternation = FORBIDDEN_MODULES.map((m) => m.replace("/", "\\/")).join("|");
const RANDOM_APIS = ["randomBytes", "randomUUID", "randomInt", "randomFill", "randomFillSync", "getRandomValues", "generateKeyPair", "generateKeyPairSync", "generateKey", "generateKeySync", "generatePrime", "generatePrimeSync",
  // Key agreement objects generate random keys.
  "createECDH", "createDiffieHellman", "createDiffieHellmanGroup", "getDiffieHellman"];
/** Node builtins transition code (non-test files) may import. Tests may also import node:test, node:assert and node:path. */
export const ALLOWED_NODE_MODULES = ["crypto"];
const ALLOWED_TEST_NODE_MODULES = ["crypto", "test", "assert", "assert/strict", "path", "url", "util", "buffer", "fs", "fs/promises", "http", "net", "module", "timers/promises"];
const GLOBAL_MEMBERS = ["fetch", "Date", "performance", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "crypto", "process", "Math", "XMLHttpRequest", "WebSocket", "EventSource", "require", "eval", "Function", "Intl", "Reflect"];

/**
 * Rules: id, pattern (applied to code with comments and strings blanked), message.
 * Regular expressions catch accidents, not adversaries: the runtime
 * poisoned-clock test (src/service/poisoned-clock.test.ts) checks the same
 * properties by executing the transitions.
 */
export const RULES = [
  // Any bare reference to fetch (a call, or an alias such as `const f = fetch`); `obj.fetch(` is a method call.
  { id: "fetch", re: /(?<![\w$.])fetch\b(?!\s*:)/g, message: "external call (fetch)" },
  { id: "date-now", re: /\bDate\s*\.\s*now\b/g, message: "wall clock (Date.now)" },
  { id: "new-date", re: /\bnew\s+Date\b/g, message: "wall clock (new Date)" },
  { id: "date-call", re: /(?<![\w$.])Date\s*\(\s*\)/g, message: "wall clock (Date())" },
  // Any other reference to Date: aliases (`const d = Date`), `Date['now']`, `{ now } = Date`, `Reflect.construct(Date, [])`.
  { id: "date-ref", re: /(?<![\w$.])(?<!\bnew\s+)Date\b(?!\s*\.\s*now\b)(?!\s*\(\s*\))/g, message: "wall clock (reference to Date)" },
  { id: "performance-now", re: /\bperformance\s*\.\s*now\b/g, message: "wall clock (performance.now)" },
  { id: "performance-ref", re: /(?<![\w$.])performance\b(?!\s*\.\s*now\b)/g, message: "wall clock (reference to performance)" },
  { id: "hrtime", re: /\bprocess\s*\.\s*hrtime\b/g, message: "wall clock (process.hrtime)" },
  { id: "process-state", re: /\bprocess\s*(?:\[|\.\s*(?:uptime|getBuiltinModule|binding|_linkedBinding|dlopen|env|cpuUsage|resourceUsage|memoryUsage|availableMemory|constrainedMemory)\b)/g, message: "process clock, environment, resources or module loader (process.uptime / env / memoryUsage / getBuiltinModule / process[...])" },
  // Scheduling- and GC-dependent behaviour: blocking waits with a timeout, weak references, finalizers.
  { id: "nondeterministic-runtime", re: /(?<![\w$.])(?:Atomics\s*\.\s*wait(?:Async)?|WeakRef|FinalizationRegistry)\b/g, message: "scheduling- or GC-dependent API (Atomics.wait / WeakRef / FinalizationRegistry)" },
  { id: "timer", re: /(?<![\w$.])(setTimeout|setInterval|setImmediate|queueMicrotask)\b/g, message: "timer (setTimeout / setInterval / setImmediate / queueMicrotask)" },
  { id: "randomness", re: new RegExp(`\\bMath\\s*(?:\\.\\s*random\\b|\\[)|(?<![\\w$])(?:${RANDOM_APIS.join("|")})\\b`, "g"), message: "randomness (Math.random, crypto random / key generation)" },
  { id: "global-object", re: new RegExp(`\\b(?:globalThis|self|window|global)\\s*(?:\\[|\\.\\s*(?:${GLOBAL_MEMBERS.join("|")})\\b)`, "g"), message: "clock, network or randomness through the global object" },
  { id: "external-api", re: /(?<![\w$.])(XMLHttpRequest|WebSocket|EventSource|createRequire|Intl)\b/g, message: "external API or locale clock (XMLHttpRequest / WebSocket / EventSource / createRequire / Intl)" },
  { id: "dynamic-code", re: /(?<![\w$.])eval\s*\(|\bnew\s+Function\b|(?<![\w$.])Function\s*\(/g, message: "dynamic code (eval / new Function)" },
  { id: "dynamic-import", re: /\b(?:import|require)\s*\(\s*(?:(?!["'`])|`[^`]*\$\{)/g, message: "import() or require() with a computed specifier" },
  { id: "net-import", re: new RegExp(`\\b(?:from|import|require)\\s*\\(?\\s*["'\`](?:node:)?(?:${moduleAlternation})["'\`/]`, "g"), message: "network / file / process / timer module import" },
];

/**
 * Allowed exceptions. `file` is relative to the repo root, `rule` is a rule id,
 * `match` (optional) limits the entry to lines containing one of the strings.
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
  {
    file: "src/core/asset-registry.test.ts",
    rule: "net-import",
    reason: "Test-only node:fs read of a committed, frozen v0.5.0 asset registry manifest (src/core/fixtures); static repository data, not live data.",
  },
  {
    file: "src/core/hpke.ts",
    rule: "randomness",
    match: ["import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes, timingSafeEqual }", "hpkeDeriveKeyPair(testOnlyEphemeralIkm ?? randomBytes(32))"],
    reason: "HPKE sender setup draws the ephemeral X25519 key (RFC 9180 SetupBaseS); called by the relay sender's client tooling, never by a transition.",
  },
  {
    file: "src/core/ed25519.ts",
    rule: "randomness",
    match: ['import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync,', 'generateKeyPairSync("ed25519")'],
    reason: "generateEd25519KeyPair() creates a key for an identity, a node or a test; it is called by key owners and tooling, never by a transition (checked at run time by src/service/poisoned-clock.test.ts).",
  },
  {
    file: "src/service/iot-m2m.ts",
    rule: "randomness",
    match: ['import { createHash, createPublicKey, generateKeyPairSync,', 'generateKeyPairSync("ed25519")'],
    reason: "createIoTMachineIdentity() creates a machine key on the machine side; no IoT transition calls it (checked at run time by src/service/poisoned-clock.test.ts).",
  },
  {
    file: "src/core/test-only.ts",
    rule: "process-state",
    match: ['process.env.NODE_ENV === "production"'],
    reason: "Configuration-time guard: rejects testOnly* options under NODE_ENV=production. Called from constructors and factories when such an option is passed, never from a transition (constructors are not transitions; checked at run time by the poisoned-clock suite).",
  },
  {
    file: "src/marketplace/multi-asset.test.ts",
    rule: "process-state",
    match: ["process.env.NODE_ENV"],
    reason: "Test-only: sets NODE_ENV=production temporarily to check that test-only credit overrides are refused in production; restored in finally.",
  },
  {
    file: "src/settlement/receipt-network.test.ts",
    rule: "net-import",
    reason: "Test-only node:fs read of the committed golden Marketplace snapshot fixture with legacy v1 receipts (src/marketplace/fixtures); static repository data, not live data.",
  },
  {
    file: "src/marketplace/marketplace-snapshot-state.test.ts",
    rule: "net-import",
    reason: "Test-only node:fs read of the committed golden format 3 Marketplace snapshot fixture (src/marketplace/fixtures/snapshots); static repository data, not live data.",
  },
  {
    file: "src/testnet/history-index.test.ts",
    rule: "performance-now",
    reason: "Test-only timing of the txId index lookup (asserted by the test); never reaches a transition.",
  },
  {
    file: "src/testnet/key-derived-accounts.test.ts",
    rule: "net-import",
    reason: "Test-only node:fs read of a committed golden snapshot fixture (v2 account ids); static repository data, not live data.",
  },
  {
    file: "src/testnet/snapshot-fixtures.test.ts",
    rule: "net-import",
    reason: "Test-only node:fs read of the committed golden snapshot fixtures (src/testnet/fixtures/snapshots, docs/COMPATIBILITY.md); static repository data, not live data.",
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
      // Look back in the already blanked output, so a comment ending in "import" does not count.
      const before = out.slice(Math.max(0, out.length - 40));
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

/**
 * Import / export-from / dynamic import() / require() statements of a source,
 * one entry per statement (several statements on one line are separate):
 * [{ index, specifier, quote, typeOnly, dynamic }]. Comments are blanked
 * first; specifier literals are kept by blankCommentsAndStrings.
 */
export function importStatements(src) {
  const code = blankCommentsAndStrings(src);
  const out = [];
  // Static: `import ... from "x"`, `import "x"`, `export ... from "x"`; the statement starts at import/export.
  const stat = /(?<![\w$.])(import|export)\b(?!\s*[.(])([^;"'`]*?)(?:\bfrom\s*)?(["'`])([^"'`]*)\3/g;
  let m;
  while ((m = stat.exec(code)) !== null) {
    const head = m[2];
    if (m[1] === "export" && !/\bfrom\s*$/.test(code.slice(m.index, m.index + m[0].length - m[4].length - 2))) continue; // `export const s = "x"` is not an import
    const typeOnly = /^\s*type\b(?!\s*,)/.test(head) && !/^\s*type\s+from\b/.test(head);
    out.push({ index: m.index, specifier: m[4], quote: m[3], typeOnly, dynamic: false });
  }
  const dyn = /(?<![\w$.])(import|require)\s*\(\s*(["'`])([^"'`]*)\2/g;
  while ((m = dyn.exec(code)) !== null) out.push({ index: m.index, specifier: m[3], quote: m[2], typeOnly: false, dynamic: true });
  return out.sort((a, b) => a.index - b.index);
}

function specifierProblem(imp, file, root, scanned, isTest) {
  const spec = imp.specifier;
  if (imp.quote === "`") return `template-literal specifier \`${spec}\``;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    if (isTest) return undefined;
    const target = relative(root, join(root, dirname(file), spec)).split(sep).join("/");
    return scanned.has(target) ? undefined : `imports ${target}, which is outside the scanned paths`;
  }
  if (spec.startsWith("node:")) {
    const mod = spec.slice(5);
    return (isTest ? ALLOWED_TEST_NODE_MODULES : ALLOWED_NODE_MODULES).includes(mod) ? undefined : `imports ${spec}, which is not an allowed node builtin`;
  }
  if (spec.startsWith("file:")) return `file: URL specifier ${spec}`;
  if (spec.startsWith("/")) return `absolute path specifier ${spec}`;
  if (spec.startsWith("#")) return `#subpath import ${spec}`;
  return `non-relative specifier ${spec} (npm package or bare builtin)`;
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
      const entry = ALLOWLIST.findIndex((a) => a.file === file && a.rule === v.rule && (a.match === undefined || a.match.some((m) => v.text.includes(m))));
      if (entry >= 0) {
        used.add(entry);
        allowed.push({ file, ...v });
      } else {
        violations.push({ file, ...v });
      }
    }
  }
  // Import closure, per statement: transition code (non-test files) may only import scanned
  // files and ALLOWED_NODE_MODULES, so a clock read cannot hide in a helper outside the
  // scanned paths. Tests may import relative helpers anywhere, but no npm, file:, absolute,
  // #subpath or template-literal specifier either.
  const scanned = new Set(files);
  for (const file of files) {
    const isTest = /\.test\.[cm]?[jt]s$/.test(file);
    const src = overrides[file] ?? readFileSync(join(root, file), "utf8");
    const lines = src.split("\n");
    for (const imp of importStatements(src)) {
      const line = src.slice(0, imp.index).split("\n").length;
      const text = (lines[line - 1] ?? "").trim();
      if (imp.typeOnly) continue; // erased at run time
      const problem = specifierProblem(imp, file, root, scanned, isTest);
      if (problem) violations.push({ file, rule: "import-closure", line, text, message: problem });
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
