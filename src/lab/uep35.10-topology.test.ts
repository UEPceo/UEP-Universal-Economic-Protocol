import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  localhostTopology,
  exampleFourMachinesTopology,
  validateTopology,
  peerListFor,
} from "./uep35-topology.ts";
import { ProcessCluster } from "./uep35-process-cluster.ts";
import { bootstrapForNode, generateBootstrap } from "./uep35-process-node.ts";

describe("UEP-35.10 multi-host topology", () => {
  it("validates localhost and example 4-machine topologies", () => {
    const local = localhostTopology(4);
    assert.equal(validateTopology(local).ok, true);
    const remote = exampleFourMachinesTopology();
    assert.equal(validateTopology(remote).ok, true);
    assert.equal(remote.endpoints.length, 4);
    assert.ok(remote.endpoints.every((e) => e.bindHost === "0.0.0.0"));
  });

  it("peerListFor excludes self", () => {
    const t = localhostTopology(4);
    const peers = peerListFor(t, "mn-0");
    assert.equal(peers.length, 3);
    assert.ok(!peers.some((p) => p.id === "mn-0"));
  });

  it("bootstrapForNode strips foreign private keys", () => {
    const full = generateBootstrap(4);
    const only = bootstrapForNode(full, "mn-1");
    const self = only.nodes.find((n) => n.id === "mn-1");
    assert.ok(self?.privateKeyHex);
    for (const n of only.nodes) {
      if (n.id !== "mn-1") assert.equal(n.privateKeyHex, undefined);
    }
  });

  it("4 process cluster converges with per-node keys", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      await cluster.propose("mn-0", [
        { id: "t10-0", from: "s0", to: "r0", amount: "2" },
      ]);
      const ok = await cluster.waitFinalized(12000);
      assert.equal(ok, true);
      assert.equal(new Set(cluster.statusRoots()).size, 1);
    } finally {
      await cluster.stop();
    }
  });
});
