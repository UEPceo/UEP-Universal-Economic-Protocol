import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findBundledUepZk } from "./uep-zk-runner.ts";
import { P4ProcessCluster, waitEvent } from "./uep38-p4-process-cluster.ts";
import { P4_PROCESS_VERSION } from "./uep38-p4-process-node.ts";

describe("UEP-38.10 P4 one OS process per node", () => {
  it("version", () => {
    assert.equal(P4_PROCESS_VERSION, "38.35");
    assert.ok(findBundledUepZk());
  });

  it("4 processes BFT-CLASSIC: prove → TCP vote → commit → same root", async () => {
    const c = new P4ProcessCluster();
    try {
      await c.start(4, 4);
      await c.propose(1000n);
      const roots = await c.waitApplied(45000);
      assert.equal(roots.length, 4);
      assert.ok(roots.every((r) => r === roots[0]));
      assert.notEqual(roots[0], "");
    } finally {
      c.stop();
    }
  });
});

describe("UEP-38.14 process respawn catch-up", () => {
  it("killed process restarts at genesis and converges via P4_COMMIT", async () => {
    const c = new P4ProcessCluster();
    try {
      await c.start(4, 4);
      await c.propose(1000n);
      const live = await c.waitApplied(undefined, 45000);
      assert.ok(live.every((r) => r === live[0]));
      const victim = c.nodes[3]!.id;
      const fresh = await c.respawn(victim);
      c.requestCatchup(victim);
      await waitEvent(fresh, (e) => e.event === "applied", 20000);
      const after = await c.waitApplied(undefined, 20000);
      assert.ok(after.every((r) => r === live[0]), String(after));
    } finally {
      c.stop();
    }
  });
});

describe("UEP-38.15 disk lastCommit", () => {
  it("solo process rebuilds applied root from last-commit.json", async () => {
    const c = new P4ProcessCluster();
    try {
      await c.start(4, 4);
      await c.propose(1000n);
      const live = await c.waitApplied(undefined, 45000);
      const id = c.nodes[0]!.id;
      c.stop();
      const solo = await c.bootFromDisk(id);
      const ready = solo.events.find((e) => e.event === "ready") as Record<string, unknown>;
      assert.equal(ready.fromDisk, true);
      solo.child.stdin.write(JSON.stringify({ op: "status" }) + "\n");
      const st = await waitEvent(solo, (e) => e.event === "status", 8000);
      assert.equal(st.root, live[0]);
      assert.equal(st.applied, true);
    } finally {
      c.stop();
    }
  });
});

describe("UEP-38.16 multi-height commit log", () => {
  // INTEGRATION CONFLICT (C-3: this test proves a spend below 1000 units; the public core charges a minimum fee of 1 unit since v0.4.4, but the UEP-26 circuit enforces floor(amount/1000) with no minimum, so the proof cannot be built). Pending a maintainer decision; see docs/LABS.md.
  it.skip("two spends persist and reload in order", async () => {
    const c = new P4ProcessCluster();
    try {
      await c.start(4, 4);
      await c.propose(1000n, 1);
      await c.waitHeight(1, 45000);
      await c.propose(500n, 2);
      await c.waitHeight(2, 45000);
      const live = await c.waitApplied(undefined, 15000);
      const id = c.nodes[0]!.id;
      c.stop();
      const solo = await c.bootFromDisk(id);
      const ready = solo.events.find((e) => e.event === "ready") as Record<string, unknown>;
      assert.equal(ready.fromDisk, true);
      solo.child.stdin.write(JSON.stringify({ op: "status" }) + "\n");
      const st = await waitEvent(solo, (e) => e.event === "status", 8000);
      assert.equal(st.root, live[0]);
      assert.deepEqual(st.heights, [1, 2]);
    } finally {
      c.stop();
    }
  });
});
