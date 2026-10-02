import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { TcpMeshEndpoint } from "./uep35-tcp-mesh.ts";
import { TcpConsensusCluster } from "./uep35-tcp-cluster.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";

function txs(n: number): BatchTx[] {
  const out: BatchTx[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `tcp-tx-${i}`,
      from: `s${i % 3}`,
      to: `r${i % 4}`,
      amount: 1n,
    });
  }
  return out;
}

describe("UEP-35.8 TCP multi-host foundation", () => {
  it("mesh hello + send/receive over real TCP", async () => {
    const a = new TcpMeshEndpoint("A");
    const b = new TcpMeshEndpoint("B");
    const portB = await b.listen();
    await a.listen();
    const got: string[] = [];
    b.onMessage((_from, kind, payload) => {
      got.push(`${kind}:${Buffer.from(payload).toString("utf8")}`);
    });
    await a.connectPeer("B", "127.0.0.1", portB);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(a.send("B", "PING", Buffer.from("hello-tcp", "utf8")), true);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(got.some((g) => g.includes("hello-tcp")));
    await a.close();
    await b.close();
  });

  it("4-node TCP cluster: propose → finality → same stateRoot", async () => {
    const c = await TcpConsensusCluster.create(4);
    try {
      const prop = await c.proposeFrom(c.nodes[0]!.id, txs(3));
      assert.ok(prop);
      await c.settle(300);
      assert.equal(c.allSameStateRoot(), true);
      assert.equal(c.allFinalized(), true);
      assert.ok(c.stats.finalities >= 1);
    } finally {
      await c.close();
    }
  });
});
