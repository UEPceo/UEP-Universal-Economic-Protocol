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

test("determinism lint: every allowlist entry is justified and test-only", () => {
  assert.ok(ALLOWLIST.length <= 3);
  for (const a of ALLOWLIST as Array<{ file: string; rule: string; reason: string }>) {
    assert.match(a.file, /\.test\.ts$/);
    assert.ok(a.reason.length > 40, a.file);
    assert.ok((RULES as Array<{ id: string }>).some((r) => r.id === a.rule));
  }
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
