import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findBundledUepZk } from "./uep-zk-runner.ts";
import {
  P4StagingLab,
  P4_STAGING_PROFILE,
  P4_STAGING_VERSION,
  serializeStagingArtifact,
  deserializeStagingArtifact,
} from "./uep38-p4-staging.ts";
import type { SpendProofArtifact } from "./uep38-zk-state-transition.ts";
import { nodeApplyVerifiedTransfer } from "./uep38-node-verify.ts";

describe("UEP-38.4 P4 Staging", () => {
  it("profile is staging-dev, not production", () => {
    assert.equal(P4_STAGING_VERSION, "38.4");
    assert.equal(P4_STAGING_PROFILE, "P4-STAGING-DEV");
    assert.ok(findBundledUepZk());
  });

  it("3 replicas: prove → verify-hex → apply → same Poseidon root", () => {
    const lab = new P4StagingLab(3, 4);
    assert.equal(lab.allSameRoot(), true);
    const before = lab.leader().state.stateRoot();
    const r = lab.commitTransfer(1000n);
    assert.equal(r.ok, true, r.reason);
    assert.notEqual(r.roots[0], before);
    assert.equal(lab.allSameRoot(), true);
    assert.equal(lab.leader().state.conservationOk(), true);
  });

  it("artifact JSON is enough for a cold replica", () => {
    const live = new P4StagingLab(1, 4);
    const r = live.commitTransfer(1000n);
    assert.equal(r.ok, true, r.reason);
    const wire = serializeStagingArtifact(r.artifact!);
    const cold = new P4StagingLab(1, 4);
    const art = deserializeStagingArtifact(wire);
    const v = nodeApplyVerifiedTransfer(cold.leader().state, cold.ids, 1000n, art);
    assert.equal(v.ok, true, !v.ok ? v.reason : "");
    assert.equal(cold.leader().state.stateRoot(), live.leader().state.stateRoot());
  });

  it("tampered proof: no replica applies", () => {
    const lab = new P4StagingLab(2, 4);
    const art = lab.commitTransfer(500n).artifact!;
    const lab2 = new P4StagingLab(2, 4);
    const bad: SpendProofArtifact = { ...art, proofHex: "ff".repeat(80) };
    const before = lab2.roots().slice();
    const v = nodeApplyVerifiedTransfer(
      lab2.leader().state,
      lab2.ids,
      500n,
      bad,
    );
    assert.equal(v.ok, false);
    assert.equal(lab2.leader().state.stateRoot(), before[0]);
  });
});

describe("UEP-38.5 P4 Staging D=32", () => {
  it("2 replicas D=32 prove → verify → same root", () => {
    const lab = new P4StagingLab(2, 32);
    const before = lab.leader().state.stateRoot();
    const r = lab.commitTransfer(1000n);
    assert.equal(r.ok, true, r.reason);
    assert.notEqual(r.roots[0], before);
    assert.equal(lab.allSameRoot(), true);
  });
});
