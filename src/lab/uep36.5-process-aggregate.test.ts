import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProcessCluster } from "./uep35-process-cluster.ts";

describe("UEP-36.5 process/TCP multi-host aggregate", () => {
  it("4 processes: aggregate 2 batches → same stateRoot", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      await cluster.proposeAggregate("mn-0", [
        [
          { id: "t1", from: "s0", to: "r0", amount: "10" },
          { id: "t2", from: "s1", to: "r1", amount: "5" },
        ],
        [{ id: "t3", from: "s2", to: "r2", amount: "3" }],
      ]);
      let ok = false;
      for (let i = 0; i < 80; i++) {
        const st = await cluster.pollStatus();
        if (
          st.every((s) => s.finalized.length >= 1) &&
          new Set(st.map((s) => s.stateRoot)).size === 1
        ) {
          ok = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(ok, true, "all processes must converge");
    } finally {
      await cluster.stop();
    }
  });

  it("process path: sequential aggregates mn-0 then mn-1", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      await cluster.proposeAggregate("mn-0", [
        [{ id: "h1", from: "s0", to: "r0", amount: "1" }],
      ]);
      for (let i = 0; i < 50; i++) {
        const st = await cluster.pollStatus();
        if (st.every((s) => s.finalized.length >= 1)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await cluster.proposeAggregate("mn-1", [
        [{ id: "h2", from: "s1", to: "r1", amount: "2" }],
      ]);
      let ok = false;
      for (let i = 0; i < 80; i++) {
        const st = await cluster.pollStatus();
        if (
          st.every((s) => s.finalized.length >= 2) &&
          new Set(st.map((s) => s.stateRoot)).size === 1
        ) {
          ok = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(ok, true);
    } finally {
      await cluster.stop();
    }
  });
});
