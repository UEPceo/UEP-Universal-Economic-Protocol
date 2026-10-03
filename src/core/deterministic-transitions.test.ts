/**
 * ADR 0002 rule 1: the determinism lint (scripts/check-deterministic-transitions.mjs)
 * is clean on the repository and catches clock reads and external calls.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore -- plain ESM script without type declarations
import { ALLOWLIST, RULES, checkRepository, scanSource, scannedFiles } from "../../scripts/check-deterministic-transitions.mjs";

test("determinism lint: transition paths have no clock reads or external calls outside the allowlist", () => {
  const result = checkRepository();
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  assert.deepEqual(result.staleAllowlist, []);
  const files: string[] = result.files;
  for (const f of ["src/marketplace/marketplace.ts", "src/testnet/ledger.ts", "src/core/security-policy.ts", "src/service/iot-m2m.ts", "src/marketplace/evidence.ts"]) assert.ok(files.includes(f), f);
});

test("determinism lint: every allowlist entry is justified; outside tests only the two key generators and the NODE_ENV guard, line-scoped", () => {
  assert.ok(ALLOWLIST.length <= 7);
  const nonTest: string[] = [];
  for (const a of ALLOWLIST as Array<{ file: string; rule: string; reason: string; match?: string[] }>) {
    assert.ok(a.reason.length > 40, a.file);
    assert.ok((RULES as Array<{ id: string }>).some((r) => r.id === a.rule));
    if (/\.test\.ts$/.test(a.file)) continue;
    nonTest.push(a.file);
    assert.ok(a.match && a.match.length > 0, `${a.file} must be limited to specific lines`);
    if (a.file === "src/core/test-only.ts") {
      assert.equal(a.rule, "process-state");
      assert.deepEqual(a.match, ['process.env.NODE_ENV === "production"']);
      continue;
    }
    assert.equal(a.rule, "randomness", a.file);
    assert.match(a.reason, /poisoned-clock\.test\.ts/);
  }
  assert.deepEqual(nonTest.sort(), ["src/core/ed25519.ts", "src/core/test-only.ts", "src/service/iot-m2m.ts"]);
  // A line-scoped entry does not cover another randomness call in the same file.
  const ed = checkRepository(undefined, { "src/core/ed25519.ts": 'import { randomBytes } from "node:crypto";\nexport const r = () => randomBytes(8);\n' });
  assert.ok(ed.violations.some((v: { file: string; rule: string }) => v.file === "src/core/ed25519.ts" && v.rule === "randomness"));
});

test("determinism lint: detects each forbidden pattern and ignores comments and strings", () => {
  const cases: Array<[string, string]> = [
    ["const t = Date.now();", "date-now"],
    ["const t = Date . now ( );", "date-now"],
    ["const d = new Date();", "new-date"],
    ["const d = new Date(0);", "new-date"],
    ["const s = Date();", "date-call"],
    ["await fetch('https://example.org');", "fetch"],
    ["const p = performance.now();", "performance-now"],
    ["const p = process.hrtime.bigint();", "hrtime"],
    ["setTimeout(() => 1, 5);", "timer"],
    ['import http from "node:http";', "net-import"],
    ['import { request } from "https";', "net-import"],
    ['import net from "node:net";', "net-import"],
    ['import { readFileSync } from "node:fs";', "net-import"],
    ['const m = await import("node:dgram");', "net-import"],
    ['const fs = require("fs");', "net-import"],
    // Evasions: aliases, the global object, randomness, timers and loaders.
    ["const D = Date; D.now();", "date-ref"],
    ["const { now } = Date;", "date-ref"],
    ["const f = globalThis['fetch'];", "global-object"],
    ["globalThis.fetch('https://example.org');", "global-object"],
    ["const g = globalThis.Date;", "global-object"],
    ["const f = fetch;", "fetch"],
    ["const r = Math.random();", "randomness"],
    ["const r = Math['random']();", "randomness"],
    ["const id = crypto.randomUUID();", "randomness"],
    ["const b = randomBytes(32);", "randomness"],
    ["const p = performance;", "performance-ref"],
    ["const u = process.uptime();", "process-state"],
    ["const e = process.env.NOW;", "process-state"],
    ["const m = process.getBuiltinModule('node:http');", "process-state"],
    ["queueMicrotask(() => 1);", "timer"],
    ['import { setTimeout as sleep } from "node:timers/promises";', "net-import"],
    ['import { createRequire } from "node:module";', "net-import"],
    ["const req = createRequire(import.meta.url);", "external-api"],
    ["const t = new Intl.DateTimeFormat().format();", "external-api"],
    ["const x = eval('Date.now()');", "dynamic-code"],
    ["const x = new Function('return Date.now()');", "dynamic-code"],
    ["const name = 'node:' + 'http'; await import(name);", "dynamic-import"],
    ["await import(`node:${'http'}`);", "dynamic-import"],
    // Second review: key agreement, process resources, scheduling- and GC-dependent APIs, Date as a function.
    ["const e = createECDH('prime256v1'); e.generateKeys();", "randomness"],
    ["const dh = createDiffieHellman(512);", "randomness"],
    ["const dh = getDiffieHellman('modp14');", "randomness"],
    ["const m = process.memoryUsage();", "process-state"],
    ["const c = process.cpuUsage();", "process-state"],
    ["Atomics.wait(view, 0, 0, 10);", "nondeterministic-runtime"],
    ["const w = new WeakRef(obj); w.deref();", "nondeterministic-runtime"],
    ["const f = new FinalizationRegistry(() => 1);", "nondeterministic-runtime"],
    ["const s = Date(0);", "date-ref"],
    ["const n = Object.getPrototypeOf(Date).now();", "date-ref"],
    ["const n = new Date(0).constructor.now();", "new-date"],
    ["const o = performance.timeOrigin;", "performance-ref"],
  ];
  for (const [src, rule] of cases) {
    const found = scanSource(src);
    assert.ok(found.some((v: { rule: string }) => v.rule === rule), `${src} -> ${rule}`);
  }
  const clean = [
    "// Date.now() in a comment",
    "/* new Date() and fetch() in a block comment */",
    "const msg = \"never call Date.now() or fetch()\";",
    "const k = `new Date() in a template`;",
    "const height = ledger.height; this.prefetch(1); obj.fetch(2);",
    'import { createHash } from "node:crypto";',
  ].join("\n");
  assert.deepEqual(scanSource(clean), []);
});

test("determinism lint: an injected Date.now in a transition file fails the repository check", () => {
  const files: string[] = scannedFiles();
  assert.ok(files.includes("src/marketplace/marketplace.ts"));
  const result = checkRepository(undefined, { "src/marketplace/marketplace.ts": "export const injected = () => Date.now();\n" });
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].file, "src/marketplace/marketplace.ts");
  assert.equal(result.violations[0].rule, "date-now");
});

test("determinism lint: transition code cannot import a helper outside the scanned paths", () => {
  const injected = 'import { clockHelper } from "../agent/clock-helper.ts";\nexport const x = clockHelper;\n';
  const result = checkRepository(undefined, { "src/marketplace/evidence.ts": injected });
  assert.ok(result.violations.some((v: { file: string; rule: string }) => v.file === "src/marketplace/evidence.ts" && v.rule === "import-closure"), JSON.stringify(result.violations));
  const reExport = checkRepository(undefined, { "src/marketplace/evidence.ts": 'export { now } from "../agent/clock-helper.ts";\nexport * from "./clock-helper.ts";\n' });
  assert.equal(reExport.violations.filter((v: { file: string; rule: string }) => v.file === "src/marketplace/evidence.ts" && v.rule === "import-closure").length, 2);
  const typeOnly = checkRepository(undefined, { "src/marketplace/evidence.ts": 'import type { X } from "../agent/clock-helper.ts";\nexport type Y = X;\n' });
  assert.ok(!typeOnly.violations.some((v: { rule: string }) => v.rule === "import-closure"));
});

test("determinism lint: the import closure is checked per statement and refuses non-relative specifiers", () => {
  const closure = (src: string, file = "src/marketplace/evidence.ts") =>
    checkRepository(undefined, { [file]: src }).violations.filter((v: { file: string; rule: string }) => v.file === file && v.rule === "import-closure").length;
  const evasions = [
    'import type { X } from "./evidence-types.ts"; import { wallNow } from "../agent/x.ts";', // two statements on one line
    'import { now } from "uep-clock";', // npm specifier
    'import { now } from "file:///tmp/clock.mjs";',
    'import { now } from "/tmp/clock.mjs";',
    'import { now } from "#clock";',
    "const m = await import(`../agent/x.ts`);", // template literal without substitutions
    'import "../agent/side-effect.ts";', // side-effect import
    'import { type A, now } from "../agent/x.ts";', // inline type modifier: still a value import
    'import os from "node:os";',
    'import { createHash } from "crypto";', // bare builtin without node:
    'const r = require("../agent/x.ts");',
    'export * as clock from "../agent/x.ts";',
  ];
  for (const src of evasions) assert.ok(closure(src) >= 1, src);
  // Allowed: scanned relative files, node:crypto, type-only imports, strings that only look like specifiers.
  for (const src of ['import { Fr } from "../core/field.ts";', 'import { createHash } from "node:crypto";', 'import type { X } from "../agent/x.ts";', 'export const s = "../agent/x.ts";', 'const t = `from "../agent/x.ts"`;']) assert.equal(closure(src), 0, src);
  // Tests may import relative helpers outside the scanned paths, but not npm, file: or absolute specifiers.
  assert.equal(closure('import { x } from "../../scripts/poisoned-clock.mjs";', "src/marketplace/evidence-caps.test.ts"), 0);
  assert.equal(closure('import { x } from "uep-clock";', "src/marketplace/evidence-caps.test.ts"), 1);
  assert.equal(closure('import { x } from "file:///tmp/x.mjs";', "src/marketplace/evidence-caps.test.ts"), 1);
});
