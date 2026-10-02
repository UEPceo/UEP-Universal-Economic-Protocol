/**
 * UEP-37.7 — Process mesh VIEW_CHANGE + silent leader timeout
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProcessCluster } from "./uep35-process-cluster.ts";
import { findUepZkBinary } from "./zk-bridge.ts";

async function pollStatus(cluster: ProcessCluster, n = 20): Promise<void> {
  for (let i = 0; i < n; i++) {
    for (const node of cluster.nodes) {
      (node as { child: { stdin: { write: (s: string) => void } } }).child.stdin.write(
        JSON.stringify({ cmd: "status" }) + "\n",
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function latestStatus(cluster: ProcessCluster, id: string): Record<string, unknown> | undefined {
  const node = cluster.nodes.find((n) => n.id === id);
  if (!node) return undefined;
  for (let i = node.events.length - 1; i >= 0; i--) {
    const e = node.events[i] as { event?: string };
    if (e.event === "status") return e as Record<string, unknown>;
  }
  return undefined;
}

describe("UEP-37.7 process mesh view-change", () => {
  it("manual advance-view rotates leader across processes", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4, { leafMode: "local" });
      await pollStatus(cluster, 15);
      const s0 = latestStatus(cluster, "mn-0");
      assert.equal(s0?.leader, "mn-0");
      assert.equal(s0?.heightView, 0);

      await cluster.advanceView("MANUAL");
      await pollStatus(cluster, 15);
      const leaders = cluster.nodes.map((n) => latestStatus(cluster, n.id)?.leader);
      assert.ok(leaders.every((l) => l === "mn-1"), `leaders=${leaders}`);
      const views = cluster.nodes.map((n) => latestStatus(cluster, n.id)?.heightView);
      assert.ok(views.every((v) => v === 1), `views=${views}`);
    } finally {
      await cluster.stop();
    }
  });

  it("NOT_LEADER when non-leader proposes", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4, { leafMode: "local" });
      await cluster.propose("mn-1", [
        { id: "x", from: "s0", to: "r0", amount: "1" },
      ]);
      // wait for error event
      await new Promise((r) => setTimeout(r, 500));
      const n1 = cluster.nodes.find((n) => n.id === "mn-1")!;
      const err = [...n1.events].reverse().find(
        (e) => (e as { event?: string; reason?: string }).event === "error",
      ) as { reason?: string } | undefined;
      assert.equal(err?.reason, "NOT_LEADER");
    } finally {
      await cluster.stop();
    }
  });

  it("silent timeout rotates then backup leader finalizes", async () => {
    assert.ok(findUepZkBinary());
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4, {
        leafMode: "poseidon-zk",
        smtDepth: 8,
        leaderTimeoutMs: 800,
      });
      // Wait for automatic view-change (mn-0 silent)
      const t0 = Date.now();
      let rotated = false;
      while (Date.now() - t0 < 5000) {
        await pollStatus(cluster, 3);
        const leaders = cluster.nodes.map((n) => latestStatus(cluster, n.id)?.leader);
        if (leaders.filter(Boolean).length === 4 && leaders.every((l) => l === "mn-1")) {
          rotated = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(rotated, true, "expected view rotation to mn-1");

      await cluster.propose("mn-1", [
        { id: "after-timeout", from: "s0", to: "r0", amount: "1" },
      ]);
      const ok = await cluster.waitRootChange(
        (latestStatus(cluster, "mn-0")?.stateRoot as string) ?? "",
        90_000,
      );
      // root may already be same string if empty wait — use waitFinalized
      const fin = await cluster.waitFinalized(90_000);
      assert.equal(fin || ok, true);
      await pollStatus(cluster, 10);
      const roots = cluster.statusRoots().filter(Boolean);
      assert.equal(new Set(roots).size, 1);
    } finally {
      await cluster.stop();
    }
  });

  it("view-changed event reports via VIEW_CHANGE_QC", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4, { leafMode: "local" });
      await cluster.advanceView("MANUAL");
      await new Promise((r) => setTimeout(r, 300));
      let found = false;
      for (const n of cluster.nodes) {
        for (const e of n.events) {
          const rec = e as { event?: string; via?: string; qcVotes?: number };
          if (rec.event === "view-changed" && rec.via === "VIEW_CHANGE_QC") {
            assert.ok((rec.qcVotes ?? 0) >= 3);
            found = true;
          }
        }
      }
      assert.equal(found, true);
    } finally {
      await cluster.stop();
    }
  });
});
