import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertBftConfig, requireClassicBft, classicQuorum } from "./uep35-bft-gate.ts";

describe("UEP-35.3 classic BFT gate", () => {
  it("accepts n=4 and n=7 as classic", () => {
    const a = assertBftConfig(4, "BFT-CLASSIC");
    assert.equal(a.ok, true);
    if (a.ok) {
      assert.equal(a.params.f, 1);
      assert.equal(a.params.quorum, 3);
    }
    const b = assertBftConfig(7, "BFT-CLASSIC");
    assert.equal(b.ok, true);
    if (b.ok) {
      assert.equal(b.params.f, 2);
      assert.equal(b.params.quorum, 5);
    }
  });

  it("rejects n=3,5,6 on BFT-CLASSIC", () => {
    for (const n of [3, 5, 6]) {
      const r = assertBftConfig(n, "BFT-CLASSIC");
      assert.equal(r.ok, false, `n=${n}`);
    }
  });

  it("LAB-MAJORITY allows n=3", () => {
    const r = assertBftConfig(3, "LAB-MAJORITY");
    assert.equal(r.ok, true);
  });

  it("requireClassicBft throws on bad n", () => {
    assert.throws(() => requireClassicBft(5));
    assert.equal(classicQuorum(4), 3);
  });
});
