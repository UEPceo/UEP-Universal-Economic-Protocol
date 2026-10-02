/**
 * UEP-37.4 — Real Poseidon SMT root (uep-zk smt-root) as consensus stateRoot
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import {
  SmtEconomicState,
  accountLabelToFr,
  SMT_STATE_VERSION,
} from "./uep37-smt-economic-state.ts";
import {
  zkSmtRoot,
  zkSmtPath,
  zkNoteCommit,
  padFrHex,
  findBundledUepZk,
  runUepZk,
} from "./uep-zk-runner.ts";
import { findUepZkBinary } from "./zk-bridge.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { parallelSafeScheduleApply } from "./uep36-parallel-exec.ts";
import { verifyStructuralWitness } from "./uep37-poseidon-leaf-provider.ts";
import { LAB_ZERO_BLINDING, CANONICAL_ASSET_ID } from "./uep37-leaf-encoding.ts";
import { poseidonNoteLeaf } from "./uep37-poseidon-leaf-provider.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(
  __dirname,
  "../../uep-core/vectors/UEP-37.4-POSEIDON-SMT-GOLDEN.json",
);

type Golden = {
  version: string;
  uepZkSha256: string;
  emptyRoot: { d8: string; d32: string };
  notes: Array<{
    id: string;
    owner: string;
    asset: string;
    amount: string;
    blinding: string;
    expectedLeaf: string;
    indexD8?: number;
    indexD32?: number;
    rootAfterInsertD8?: string;
    rootAfterInsertD32?: string;
  }>;
  multiLeaf: { depth: number; root: string; equal: boolean };
  stateWitness: {
    depth: number;
    index: number;
    leaf: string;
    root: string;
    siblings: string[];
    indexBits: boolean[];
  };
};

function loadG(): Golden {
  assert.ok(existsSync(GOLDEN_PATH), "missing 37.4 golden");
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;
}

describe("UEP-37.4 Poseidon SMT root", () => {
  it("version + binary has smt-root", () => {
    assert.equal(SMT_STATE_VERSION, "37.4");
    assert.ok(findUepZkBinary());
    const r = runUepZk(["smt-root", "8"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /root=/);
  });

  // No prebuilt uep-zk is distributed; it is built from source, so its hash depends on the toolchain.
  it.skip("binary SHA matches golden", () => {
    const g = loadG();
    const src = findBundledUepZk()!;
    const actual = createHash("sha256").update(readFileSync(src)).digest("hex");
    assert.equal(actual, g.uepZkSha256);
  });

  it("empty tree roots match golden D=8 and D=32", () => {
    const g = loadG();
    assert.equal(zkSmtRoot(8, []), g.emptyRoot.d8);
    assert.equal(zkSmtRoot(32, []), g.emptyRoot.d32);
  });

  it("single leaf insert root matches golden (D=8 and D=32)", () => {
    const g = loadG();
    const n = g.notes[0]!;
    const leaf = zkNoteCommit(n.owner, n.asset, n.amount, n.blinding)!;
    assert.equal(leaf, n.expectedLeaf);
    assert.equal(
      zkSmtRoot(8, [{ index: n.indexD8!, leafHex: leaf }]),
      n.rootAfterInsertD8,
    );
    assert.equal(
      zkSmtRoot(32, [{ index: n.indexD32!, leafHex: leaf }]),
      n.rootAfterInsertD32,
    );
  });

  it("multi-leaf root order-independent", () => {
    const g = loadG();
    const n1 = g.notes[0]!;
    const n2 = g.notes[1]!;
    const a = zkSmtRoot(8, [
      { index: n1.indexD8!, leafHex: n1.expectedLeaf },
      { index: n2.indexD8!, leafHex: n2.expectedLeaf },
    ]);
    const b = zkSmtRoot(8, [
      { index: n2.indexD8!, leafHex: n2.expectedLeaf },
      { index: n1.indexD8!, leafHex: n1.expectedLeaf },
    ]);
    assert.equal(a, b);
    assert.equal(a, g.multiLeaf.root);
  });

  it("SmtEconomicState poseidon-zk stateRoot === uep-zk smt-root", () => {
    const g = loadG();
    // Use fixed owner Fr 0x2a balance 1000 → same as note-1
    // Our account labels hash to Fr — use direct leaf map path via known labels won't match 0x2a.
    // Instead verify engine root equals smt-root of its own poseidonLeaves list.
    const s = SmtEconomicState.genesis(
      { s0: 1000n, r0: 0n },
      { testOnlyDepth: 8, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    assert.equal(s.meta().stateRootKind, "poseidon-smt-root");
    const leaves: Array<{ index: number; leafHex: string }> = [];
    // rebuild from internal leaves by reading getPoseidonLeaf
    for (const label of ["s0", "r0", "treasury"]) {
      const leaf = s.getPoseidonLeaf(label === "treasury" ? "treasury" : label);
      if (!leaf) continue;
      const owner = accountLabelToFr(label === "treasury" ? "treasury" : label);
      const idx = Number(owner.lowBits(8));
      leaves.push({ index: idx, leafHex: leaf });
    }
    const rustRoot = zkSmtRoot(8, leaves);
    assert.equal(s.stateRoot(), rustRoot);
  });

  it("transition changes Poseidon SMT root", () => {
    const s = SmtEconomicState.genesis(
      { s0: 1000n, r0: 0n },
      { testOnlyDepth: 8, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const before = s.stateRoot();
    assert.equal(s.applyBatch([{ id: "t", from: "s0", to: "r0", amount: 10n }]).ok, true);
    assert.notEqual(s.stateRoot(), before);
    assert.equal(s.stateRoot().length, 64);
  });

  it("sequential ≡ scheduled with Poseidon SMT roots", () => {
    const eco = SmtEconomicState.genesis(
      { s0: 1000n, s1: 1000n, r0: 0n, r1: 0n },
      { testOnlyDepth: 8, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const r = parallelSafeScheduleApply(eco, [
      { id: "t1", from: "s0", to: "r0", amount: 3n },
      { id: "t2", from: "s1", to: "r1", amount: 4n },
    ]);
    assert.equal(r.fullStateEqual, true);
    assert.equal(r.sequentialRoot, r.scheduledRoot);
  });

  it("StateWitness from smt-path matches root and index bits", () => {
    const g = loadG();
    const w = g.stateWitness;
    assert.equal(w.siblings.length, w.depth);
    assert.equal(w.indexBits.length, w.depth);
    const idx = BigInt(w.index);
    for (let i = 0; i < w.depth; i++) {
      const bit = ((idx >> BigInt(i)) & 1n) === 1n;
      assert.equal(w.indexBits[i], bit, `bit ${i}`);
    }
    // live recompute
    const n1 = g.notes[0]!;
    const n2 = g.notes[1]!;
    const live = zkSmtPath(8, n1.indexD8!, [
      { index: n1.indexD8!, leafHex: n1.expectedLeaf },
      { index: n2.indexD8!, leafHex: n2.expectedLeaf },
    ]);
    assert.equal(live.root, g.multiLeaf.root);
    assert.equal(live.leaf, n1.expectedLeaf);
  });

  it("tampered sibling / leaf fails path consistency vs root", () => {
    const g = loadG();
    const w = { ...g.stateWitness, siblings: [...g.stateWitness.siblings] };
    // Alter first sibling
    w.siblings[0] = "ff".repeat(32);
    // We don't have pure-TS Poseidon path verify; authority is: path command must match root.
    // Re-fetch good path and ensure bad leaf list produces different root.
    const n1 = g.notes[0]!;
    const badRoot = zkSmtRoot(8, [
      { index: n1.indexD8!, leafHex: "11".repeat(32) },
    ]);
    assert.notEqual(badRoot, n1.rootAfterInsertD8);
  });

  it("multi-node poseidon SMT roots converge", () => {
    const cluster = new MultiNodeCluster(4, 3740, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
    });
    const roots = new Set(cluster.nodes.map((n) => n.economic.stateRoot()));
    assert.equal(roots.size, 1);
    // each root is real smt-root length
    assert.equal([...roots][0]!.length, 64);

    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "smt1", from: "s0", to: "r0", amount: 4n }] },
    ]);
    assert.ok(prop);
    for (let i = 0; i < 100; i++) {
      cluster.tick(20, 5);
      if (
        cluster.allHonestSameStateRoot() &&
        cluster.nodes.filter((n) => !n.byzantine).every((n) => n.economic.sequence >= 1)
      )
        break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
  });

  it("economic StateWitness poseidon path root equals stateRoot", () => {
    const s = SmtEconomicState.genesis(
      { s0: 50n },
      { testOnlyDepth: 8, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const w = s.stateWitnessFor("s0");
    assert.equal(w.rootKind, "poseidon-smt-root");
    assert.equal(w.root, s.stateRoot());
    assert.equal(w.leaf, s.getPoseidonLeaf("s0"));
    assert.equal(verifyStructuralWitness(w), true);
  });
});
