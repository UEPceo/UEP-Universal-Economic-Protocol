/**
 * UEP-29.4 closure tests — NO SKIP for Groth16 paths.
 * Missing uep-zk ⇒ FAIL (assert throws / assert.fail).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import { PoseidonLabEngine } from "./poseidon-lab-engine.ts";
import { runLabBenchmark, writeBenchmarkReport } from "./poseidon-lab-benchmark.ts";
import { findUepZkBinary } from "./zk-bridge.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(here, "../../artifacts/uep-29.4-evidence");

function requireBinary(): string {
  const bin = findUepZkBinary();
  assert.ok(
    bin,
    "FAIL: uep-zk binary not found. Build it with: npm run build:uep-zk (or set UEP_ZK_BIN)",
  );
  return bin;
}

describe("UEP-29.4 structural lab (no proof)", () => {
  it("20 sequential structural spends conserve balance", () => {
    const eng = new PoseidonLabEngine({
      depth: 4,
      networkId: "lab",
      domainId: "LAB",
      profile: "local",
      requireProof: false,
    });
    eng.registerAccount("alice", {
      secret: Fr.from(11n),
      salt: Fr.from(22n),
      blinding: Fr.from(3n),
      balance: 1_000_000n,
    });
    eng.registerAccount("bob", {
      secret: Fr.from(33n),
      salt: Fr.from(44n),
      blinding: Fr.from(4n),
      balance: 0n,
    });
    const before = eng.totalBalances();
    for (let i = 0; i < 20; i++) {
      const r = eng.spend("alice", "bob", 1000n, i);
      assert.equal(r.ok, true, r.error);
    }
    assert.equal(eng.totalBalances(), before);
    assert.equal(eng.historyCount, 20);
  });
});

describe("UEP-29.4 Groth16 D=4 ×3 (HARD FAIL if no binary)", () => {
  it("three sequential Groth16 spends with real phase timings", () => {
    const bin = requireBinary();
    const report = runLabBenchmark({ depth: 4, txCount: 3, requireProof: true });
    assert.equal(report.okCount, 3, JSON.stringify(report));
    assert.equal(report.failCount, 0);
    // Real timings — not estimated
    for (const p of report.phases.proveMs) {
      assert.ok(p > 0, "prove_ms must be measured by Rust CLI");
    }
    for (const v of report.phases.verifyMs) {
      assert.ok(v >= 0);
    }
    assert.ok(report.averages.proveMs > 0);
    assert.ok(report.vkIds.length >= 1);
    fs.mkdirSync(evidenceDir, { recursive: true });
    const out = path.join(evidenceDir, "benchmark-d4-prove-x3.json");
    writeBenchmarkReport(report, out);
    fs.writeFileSync(
      path.join(evidenceDir, "binary-path.txt"),
      `uep-zk=${bin}\n`,
    );
    assert.ok(fs.existsSync(out));
  });
});

describe("UEP-29.4 Groth16 D=32 ×2 (HARD FAIL if no binary)", () => {
  it("two sequential Groth16 D=32 spends", () => {
    requireBinary();
    const report = runLabBenchmark({ depth: 32, txCount: 2, requireProof: true });
    assert.equal(report.okCount, 2, JSON.stringify(report));
    assert.equal(report.failCount, 0);
    for (const p of report.phases.proveMs) {
      assert.ok(p > 0, "D=32 prove_ms must be real");
    }
    fs.mkdirSync(evidenceDir, { recursive: true });
    writeBenchmarkReport(report, path.join(evidenceDir, "benchmark-d32-prove-x2.json"));
  });
});
