/**
 * UEP-37.2 — Poseidon golden vectors via uep-zk (must MATCH, no SKIP).
 *
 * If uep-zk is missing or a leaf diverges → FAIL (not skip).
 * SMT root Poseidon: deferred until binary includes smt-root (source already patched).
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { findUepZkBinary, runUepZk } from "./zk-bridge.ts";
import { zkNoteCommit, padFrHex, findBundledUepZk } from "./uep-zk-runner.ts";
import {
  noteCommitment,
  leafEncodingMeta,
  isPoseidonBackendActive,
} from "./uep37-leaf-encoding.ts";
import { Fr } from "../core/field.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(
  __dirname,
  "../../uep-core/vectors/UEP-37-POSEIDON-GOLDEN.json",
);

type Golden = {
  version: string;
  uepZkSha256: string;
  notes: Array<{
    id: string;
    owner: string;
    asset: string;
    amount: string;
    blinding: string;
    expectedLeaf: string;
    expectedIndexD32: number;
  }>;
  hAccounts: Array<{
    id: string;
    secret: string;
    salt: string;
    expectedAccountId: string;
    expectedIndexD32: number;
  }>;
};

function loadGolden(): Golden {
  assert.ok(existsSync(GOLDEN_PATH), `missing golden file: ${GOLDEN_PATH}`);
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;
}

function requireZk(): string {
  const bin = findUepZkBinary();
  assert.ok(bin, "uep-zk binary required for UEP-37.2 (materialize to /tmp if under artifacts)");
  return bin;
}

describe("UEP-37.2 Poseidon golden (uep-zk)", () => {
  it("golden file exists and version is 37.2", () => {
    const g = loadGolden();
    assert.equal(g.version, "37.2");
    assert.ok(g.notes.length >= 6);
  });

  // No prebuilt uep-zk is distributed; it is built from source, so its hash depends on the toolchain.
  it.skip("bundled uep-zk SHA-256 matches frozen golden", () => {
    const g = loadGolden();
    const src = findBundledUepZk();
    assert.ok(src, "bundled uep-zk missing");
    const actual = createHash("sha256").update(readFileSync(src!)).digest("hex");
    assert.equal(actual, g.uepZkSha256, "uep-zk binary changed without regenerating golden");
  });

  it("uep-zk is runnable (circuit-id)", () => {
    requireZk();
    const r = runUepZk(["circuit-id"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /UEP-27-SPEND-POSEIDON-D32-v2-domain/); // circuit frozen in UEP-38.35 (13 publics, domain_id)
    assert.match(r.stdout, /constraints=153098/);
  });

  it("every note-commit golden matches live uep-zk", () => {
    requireZk();
    const g = loadGolden();
    for (const c of g.notes) {
      const leaf = zkNoteCommit(c.owner, c.asset, c.amount, c.blinding);
      assert.ok(leaf, `note-commit failed for ${c.id}`);
      assert.equal(
        leaf,
        c.expectedLeaf,
        `leaf mismatch ${c.id}: got ${leaf} expected ${c.expectedLeaf}`,
      );
    }
  });

  it("low-bits D=32 matches golden for each owner", () => {
    requireZk();
    const g = loadGolden();
    for (const c of g.notes) {
      const r = runUepZk(["low-bits", padFrHex(c.owner), "32"]);
      assert.equal(r.status, 0, r.stderr);
      const m = r.stdout.match(/index=(\d+)/);
      assert.ok(m);
      assert.equal(Number(m![1]), c.expectedIndexD32, `index mismatch ${c.id}`);
    }
  });

  it("h-account goldens match live uep-zk", () => {
    requireZk();
    const g = loadGolden();
    for (const a of g.hAccounts) {
      const r = runUepZk(["h-account", padFrHex(a.secret), padFrHex(a.salt)]);
      assert.equal(r.status, 0, r.stderr);
      const id = r.stdout.match(/account_id=([0-9a-fA-F]+)/)?.[1]?.toLowerCase().padStart(64, "0");
      assert.equal(id, a.expectedAccountId, a.id);
      const idx = Number(r.stdout.match(/index_d32=(\d+)/)?.[1]);
      assert.equal(idx, a.expectedIndexD32, a.id);
    }
  });

  it("TS pure noteCommitment is NOT claimed equal to Poseidon (backend honesty)", () => {
    // UEP-25 placeholder must differ or at least not be advertised as Poseidon
    assert.equal(isPoseidonBackendActive(), false);
    assert.equal(leafEncodingMeta().poseidonBitIdentical, false);
    const g = loadGolden();
    const c = g.notes[0]!;
    const tsLeaf = noteCommitment(
      Fr.from("0x" + c.owner),
      Fr.from("0x" + c.asset),
      Fr.from("0x" + c.amount),
      Fr.from("0x" + c.blinding),
    ).toHex();
    // Structural: if someone swaps backend to Poseidon later, this may start matching.
    // Until then, divergence is expected and documents the gap.
    if (tsLeaf === c.expectedLeaf) {
      // Only acceptable if backend was upgraded to Poseidon
      assert.equal(isPoseidonBackendActive(), true);
    } else {
      assert.notEqual(tsLeaf, c.expectedLeaf);
    }
  });

  it("smt-root is available in shipped binary (37.4+)", () => {
    requireZk();
    const r = runUepZk(["smt-root", "8"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /root=/);
  });
});
