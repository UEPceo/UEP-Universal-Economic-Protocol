/**
 * UEP-37.3 — Poseidon leaves in consensus state + StateWitness shape
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import {
  SmtEconomicState,
  accountLabelToFr,
  SMT_STATE_VERSION,
} from "./uep37-smt-economic-state.ts";
import {
  poseidonNoteLeaf,
  requireUepZk,
  verifyStructuralWitness,
} from "./uep37-poseidon-leaf-provider.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { parallelSafeScheduleApply } from "./uep36-parallel-exec.ts";
import { LAB_ZERO_BLINDING, CANONICAL_ASSET_ID } from "./uep37-leaf-encoding.ts";
import { findUepZkBinary } from "./zk-bridge.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, "../../uep-core/vectors/UEP-37-POSEIDON-GOLDEN.json"),
    "utf8",
  ),
) as {
  notes: Array<{
    id?: string;
    owner: string;
    asset: string;
    amount: string;
    blinding: string;
    expectedLeaf: string;
  }>;
};

describe("UEP-37.3 Poseidon leaves + StateWitness", () => {
  it("state version is 37.x", () => {
    assert.match(SMT_STATE_VERSION, /^37\./);
  });

  it("uep-zk available", () => {
    assert.ok(findUepZkBinary(), "uep-zk required");
    requireUepZk();
  });

  it("poseidonNoteLeaf matches frozen golden note-1", () => {
    const c = GOLDEN.notes.find((n) => n.id === "note-1") ?? GOLDEN.notes[0]!;
    const leaf = poseidonNoteLeaf(
      Fr.from("0x" + c.owner),
      BigInt("0x" + c.amount),
      Fr.from("0x" + c.blinding),
      Fr.from("0x" + c.asset),
    );
    assert.equal(leaf, c.expectedLeaf);
  });

  it("poseidon-zk genesis leaves are real Poseidon", () => {
    const s = SmtEconomicState.genesis(
      { s0: 1000n },
      { testOnlyDepth: 8, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    assert.equal(s.meta().leafMode, "poseidon-zk");
    assert.equal(s.meta().stateRootKind, "poseidon-smt-root");
    const owner = accountLabelToFr("s0");
    const expected = poseidonNoteLeaf(owner, 1000n, LAB_ZERO_BLINDING, CANONICAL_ASSET_ID);
    assert.equal(s.getPoseidonLeaf("s0"), expected);
  });

  it("two independent poseidon-zk states same transfers → same stateRoot", () => {
    const opts = {
      testOnlyDepth: 8 as const,
      isTestFixture: true as const,
      leafMode: "poseidon-zk" as const,
    };
    const a = SmtEconomicState.genesis({ s0: 1000n, r0: 0n }, opts);
    const b = SmtEconomicState.genesis({ s0: 1000n, r0: 0n }, opts);
    assert.equal(a.stateRoot(), b.stateRoot());
    const txs = [{ id: "t1", from: "s0", to: "r0", amount: 10n }];
    const before = a.stateRoot();
    assert.equal(a.applyBatch(txs).ok, true);
    assert.equal(b.applyBatch(txs).ok, true);
    assert.equal(a.stateRoot(), b.stateRoot());
    assert.notEqual(before, a.stateRoot());
    // tip: previousRoot tracks last committed root (== stateRoot at rest)
    assert.equal(a.previousRoot(), a.stateRoot());
  });

  it("sequential ≡ scheduled under poseidon-zk leaf digest", () => {
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

  it("StateWitness shape + index bits for account", () => {
    const s = SmtEconomicState.genesis(
      { s0: 50n },
      { testOnlyDepth: 8, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const w = s.stateWitnessFor("s0");
    assert.equal(w.depth, 8);
    assert.equal(w.siblings.length, 8);
    assert.equal(w.indexBits.length, 8);
    assert.ok(w.rootKind === "poseidon-smt-root" || w.rootKind === "structural-smt");
    assert.equal(verifyStructuralWitness(w), true);
    assert.equal(w.leaf, s.getPoseidonLeaf("s0"));
  });

  it("poseidon-zk stateRoot differs from structural mode", () => {
    const bal = { s0: 100n, r0: 0n };
    const p = SmtEconomicState.genesis(bal, {
      testOnlyDepth: 8,
      isTestFixture: true,
      leafMode: "poseidon-zk",
    });
    const st = SmtEconomicState.genesis(bal, {
      testOnlyDepth: 8,
      isTestFixture: true,
      leafMode: "structural",
    });
    assert.notEqual(p.stateRoot(), st.stateRoot());
  });

  it("multi-node poseidon-zk leaves converge", () => {
    const cluster = new MultiNodeCluster(4, 3730, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
    });
    const eco0 = cluster.node("mn-0").economic as SmtEconomicState;
    assert.equal(eco0.leafMode, "poseidon-zk");
    const g = new Set(cluster.nodes.map((n) => n.economic.stateRoot()));
    assert.equal(g.size, 1);

    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "pz1", from: "s0", to: "r0", amount: 5n }] },
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
});
