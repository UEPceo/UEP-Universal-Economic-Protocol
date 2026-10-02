import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findUepZkBinary } from "./zk-bridge.ts";
import { runPaymentToReplicaE2E } from "./e2e-pipeline.ts";

describe("UEP-32 E2E Payment → Engine → Envelope → Replica", () => {
  it("structural path: payment settles and replica matches sequencer root", async () => {
    const r = await runPaymentToReplicaE2E({ amount: 2000n, requireProof: false });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.paymentUri?.startsWith("uep:pay?"));
    assert.ok(r.transitionIds.length >= 1);
    assert.equal(r.rootsMatch, true);
    assert.equal(r.sequencerRoot, r.replicaRoot);
  });

  it("ZK path D=4: Groth16 prove → commit → authenticated replica same root", async () => {
    const bin = findUepZkBinary();
    assert.ok(bin, "uep-zk binary required for ZK E2E");
    const r = await runPaymentToReplicaE2E({ amount: 1500n, requireProof: true });
    assert.equal(r.ok, true, r.error ?? "ZK E2E failed");
    assert.ok(r.transitionIds.length >= 1);
    assert.equal(r.rootsMatch, true);
    assert.ok(r.sequencerRoot && r.sequencerRoot !== "GENESIS");
    assert.equal(r.sequencerRoot, r.replicaRoot);
  });
});
