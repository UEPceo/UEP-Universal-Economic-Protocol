import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProcessCluster } from "./uep35-process-cluster.ts";
import { TcpMeshEndpoint } from "./uep35-tcp-mesh.ts";

describe("UEP-35.11 multi-process partition + recovery", () => {
  it("mesh blocks send/receive to partitioned peers", async () => {
    const a = new TcpMeshEndpoint("A");
    const b = new TcpMeshEndpoint("B");
    const portB = await b.listen();
    await a.listen();
    const got: string[] = [];
    b.onMessage((_f, kind, payload) => {
      got.push(`${kind}:${Buffer.from(payload).toString("utf8")}`);
    });
    await a.connectPeer("B", "127.0.0.1", portB);
    await new Promise((r) => setTimeout(r, 30));
    a.blockPeer("B");
    assert.equal(a.send("B", "PING", Buffer.from("blocked", "utf8")), false);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!got.some((g) => g.includes("blocked")));
    a.unblockPeer("B");
    assert.equal(a.send("B", "PING", Buffer.from("open", "utf8")), true);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(got.some((g) => g.includes("open")));
    await a.close();
    await b.close();
  });

  it("partition 3|1: majority can finalize; minority stays behind", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      // Isolate mn-3 from the rest
      await cluster.partition(["mn-0", "mn-1", "mn-2"], ["mn-3"]);

      await cluster.propose("mn-0", [
        { id: "part-1", from: "s0", to: "r0", amount: "1" },
      ]);

      // Majority (3) should be able to form BFT quorum=3 and finalize
      const t0 = Date.now();
      let majorityFinal = false;
      while (Date.now() - t0 < 10000) {
        const st = await cluster.pollStatus();
        const maj = st.filter((s) => s.nodeId !== "mn-3");
        if (maj.every((s) => s.finalized.length >= 1)) {
          majorityFinal = true;
          // minority should still have 0 finalized OR different progress
          const min = st.find((s) => s.nodeId === "mn-3")!;
          assert.ok(
            min.finalized.length === 0 ||
              min.stateRoot !== maj[0]!.stateRoot ||
              min.finalized.length === 0,
            "isolated node must not silently share majority finality without messages",
          );
          // Prefer: isolated has no finality
          assert.equal(min.finalized.length, 0);
          const roots = new Set(maj.map((s) => s.stateRoot));
          assert.equal(roots.size, 1);
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.equal(majorityFinal, true);
    } finally {
      await cluster.stop();
    }
  });

  it("partition then heal + resync → all 4 same stateRoot", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      await cluster.partition(["mn-0", "mn-1", "mn-2"], ["mn-3"]);

      await cluster.propose("mn-0", [
        { id: "heal-1", from: "s1", to: "r1", amount: "1" },
      ]);

      // Wait majority final
      let okMaj = false;
      for (let i = 0; i < 40; i++) {
        const st = await cluster.pollStatus();
        if (st.filter((s) => s.nodeId !== "mn-3").every((s) => s.finalized.length >= 1)) {
          okMaj = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.equal(okMaj, true);

      // Heal and resync
      await cluster.heal();

      // Wait all 4 converge
      let converged = false;
      for (let i = 0; i < 50; i++) {
        const st = await cluster.pollStatus();
        if (
          st.every((s) => s.finalized.length >= 1) &&
          new Set(st.map((s) => s.stateRoot)).size === 1
        ) {
          converged = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.equal(converged, true, "after heal+resync all processes must share stateRoot");
    } finally {
      await cluster.stop();
    }
  });
});
