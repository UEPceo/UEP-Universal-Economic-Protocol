import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { findBundledUepZk } from "./uep-zk-runner.ts";
import { P4MeshNode, P4_MESH_VERSION } from "./uep38-p4-mesh.ts";

describe("UEP-38.6 P4 Staging TCP mesh", () => {
  it("version + binary", () => {
    assert.equal(P4_MESH_VERSION, "38.6");
    assert.ok(findBundledUepZk());
  });

  it("leader proves; follower verifies over TCP; same root", async () => {
    const a = new P4MeshNode("a", 4);
    const b = new P4MeshNode("b", 4);
    const pa = await a.listen();
    const pb = await b.listen();
    await a.connect("b", pb);
    await b.connect("a", pa);
    const before = a.state.stateRoot();
    const r = await a.commitAndBroadcast(1000n);
    assert.equal(r.ok, true, r.reason);
    for (let i = 0; i < 40; i++) {
      if (b.state.stateRoot() === a.state.stateRoot() && b.state.stateRoot() !== before) break;
      await sleep(50);
    }
    assert.equal(b.lastError, null, String(b.lastError));
    assert.equal(b.state.stateRoot(), a.state.stateRoot());
    assert.notEqual(a.state.stateRoot(), before);
    await a.close();
    await b.close();
  });
});
