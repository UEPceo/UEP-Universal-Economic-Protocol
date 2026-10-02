import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import { findBundledUepZk } from "./uep-zk-runner.ts";
import {
  defaultAlignedAccounts,
  bindCircuitAccounts,
  proveWithoutApply,
  applyTransfer,
  UEP38_VERSION,
} from "./uep38-zk-state-transition.ts";
import {
  verifyArtifactAgainstRoots,
  nodeApplyVerifiedTransfer,
} from "./uep38-node-verify.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(__dirname, "../../uep-core/vectors/UEP-38.1-D32-GOLDEN.json");

describe("UEP-38.1 D=32 golden", () => {
  it("version bumped", () => {
    assert.equal(UEP38_VERSION, "38.35");
    assert.ok(findBundledUepZk());
  });

  it("D=32 prove roots match SMT and persist golden", () => {
    const st = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: 32, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const ids = defaultAlignedAccounts();
    bindCircuitAccounts(st, ids);
    const oldRoot = st.stateRoot();
    const art = proveWithoutApply(st, ids, 1000n);
    assert.equal(art.ok, true, art.stderr + art.stdout.slice(0, 400));
    assert.equal(art.oldRootProof, oldRoot.toLowerCase());
    const applied = applyTransfer(st, ids, 1000n);
    assert.equal(applied.ok, true);
    assert.equal(art.newRootProof, applied.newRoot.toLowerCase());

    const rec = {
      version: "38.1",
      depth: 32,
      amount: "1000",
      oldRoot,
      newRoot: applied.newRoot,
      public_0: art.publicInputsHex[0],
      public_1: art.publicInputsHex[1],
    };
    mkdirSync(dirname(GOLDEN), { recursive: true });
    if (!existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(rec, null, 2));
    } else {
      const g = JSON.parse(readFileSync(GOLDEN, "utf8")) as typeof rec;
      assert.equal(g.oldRoot, rec.oldRoot);
      assert.equal(g.newRoot, rec.newRoot);
    }
  });
});

describe("UEP-38.2 node verify before apply", () => {
  it("honest D=4: verify-hex then apply", () => {
    const prover = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const replica = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const ids = defaultAlignedAccounts();
    bindCircuitAccounts(prover, ids);
    bindCircuitAccounts(replica, ids);
    const art = proveWithoutApply(prover, ids, 1000n);
    assert.equal(art.ok, true, art.stderr);
    const r = nodeApplyVerifiedTransfer(replica, ids, 1000n, art);
    assert.equal(r.ok, true, !r.ok ? r.reason : "");
    applyTransfer(prover, ids, 1000n);
    assert.equal(replica.stateRoot(), prover.stateRoot());
  });

  it("tampered proof rejected; replica root unchanged", () => {
    const replica = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const ids = defaultAlignedAccounts();
    bindCircuitAccounts(replica, ids);
    const art = proveWithoutApply(replica, ids, 1000n);
    const before = replica.stateRoot();
    const bad = { ...art, proofHex: "aa".repeat(64) };
    const v = verifyArtifactAgainstRoots(bad, before);
    assert.equal(v.ok, false);
    assert.equal(replica.stateRoot(), before);
  });

  it("wrong old root rejected", () => {
    const st = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: 4, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    const ids = defaultAlignedAccounts();
    bindCircuitAccounts(st, ids);
    const art = proveWithoutApply(st, ids, 1000n);
    const v = verifyArtifactAgainstRoots(art, "00".repeat(32));
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "OLD_ROOT_MISMATCH");
  });
});
