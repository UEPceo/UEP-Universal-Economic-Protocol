import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TcpMeshEndpoint } from "./uep35-tcp-mesh.ts";

describe("UEP-38.19 mesh dedup", () => {
  it("bidirectional connect keeps both peers", async () => {
    const a = new TcpMeshEndpoint("A");
    const b = new TcpMeshEndpoint("B");
    const portA = await a.listen();
    const portB = await b.listen();
    assert.equal(await a.connectPeer("B", "127.0.0.1", portB), true);
    assert.equal(await b.connectPeer("A", "127.0.0.1", portA), true);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(a.peerIds().includes("B"));
    assert.ok(b.peerIds().includes("A"));
    const got: string[] = [];
    b.onMessage((_f, kind) => got.push(kind));
    const big = Buffer.alloc(200_000, 7);
    a.broadcast("P4_PROPOSAL", big);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(got.includes("P4_PROPOSAL"), got.join(","));
    await a.close();
    await b.close();
  });
});
