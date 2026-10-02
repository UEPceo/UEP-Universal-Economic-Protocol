import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { findBundledUepZk } from "./uep-zk-runner.ts";
import { P4QuorumMesh, P4_QMESH_VERSION } from "./uep38-p4-quorum-mesh.ts";

describe("UEP-38.9 P4 quorum over TCP", () => {
  it("version", () => {
    assert.equal(P4_QMESH_VERSION, "38.9");
    assert.ok(findBundledUepZk());
  });

  it("3 nodes: proposal → votes → commit on wire → same root", async () => {
    const mesh = new P4QuorumMesh(4);
    await mesh.start();
    const before = mesh.lab.replicas[0]!.state.stateRoot();
    await mesh.propose(1000n, 1);
    for (let i = 0; i < 80; i++) {
      if (mesh.committed) break;
      await sleep(50);
    }
    assert.equal(mesh.lastError, null, String(mesh.lastError));
    assert.equal(mesh.committed, true);
    const roots = mesh.lab.replicas.map((r) => r.state.stateRoot());
    assert.ok(roots.every((x) => x === roots[0]));
    assert.notEqual(roots[0], before);
    await mesh.close();
  });
});
