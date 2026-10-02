import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { SpendInbox, LabCompute, LabRelay, LabOracle } from "./uep-service-backends.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";

describe("UEP-API-001.2 spend compute relay oracle", () => {
  it("queues a spend, does not finalize, and serves lab compute/relay/oracle", async () => {
    const oracle = new LabOracle();
    oracle.set("power.price", "10");
    const api = new UepServiceApi({
      storageProviders: new Map([["memory", new MemoryStorageProvider()]]),
      spends: new SpendInbox(),
      compute: new LabCompute(),
      relay: new LabRelay(),
      oracle,
    });
    const cap = api.capabilities();
    assert.equal(cap.services.compute, true);
    assert.equal(cap.services.oracle, true);
    const { server, port } = await listenUepHttpApi({ api });
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/v1/spends`, {
        method: "POST",
        body: JSON.stringify({ sender: "alice", recipient: "bob", amount: "10", nonce: "1" }),
      });
      assert.equal(bad.status, 400);
      const spend = await fetch(`http://127.0.0.1:${port}/v1/spends`, {
        method: "POST",
        body: JSON.stringify({ sender: "alice", recipient: "bob", amount: "10", nonce: "1", domainId: "lab" }),
      });
      const spendBody = await spend.json() as { data: { status: string; final: boolean } };
      assert.equal(spend.status, 202);
      assert.equal(spendBody.data.status, "QUEUED");
      assert.equal(spendBody.data.final, false);
      const replay = await fetch(`http://127.0.0.1:${port}/v1/spends`, {
        method: "POST",
        body: JSON.stringify({ sender: "alice", recipient: "bob", amount: "10", nonce: "1", domainId: "lab" }),
      });
      assert.equal(replay.status, 400);

      const job = await fetch(`http://127.0.0.1:${port}/v1/compute/jobs?programId=hash`, { method: "POST", body: "abc" });
      const jobBody = await job.json() as { data: { confidence: string } };
      assert.equal(jobBody.data.confidence, "LAB");

      const rel = await fetch(`http://127.0.0.1:${port}/v1/relay/envelopes`, {
        method: "POST",
        body: JSON.stringify({ id: "e1", body: "envelope" }),
      });
      const relBody = await rel.json() as { data: { final: boolean } };
      assert.equal(relBody.data.final, false);

      const q = await fetch(`http://127.0.0.1:${port}/v1/oracle/quotes/power.price`);
      const qBody = await q.json() as { data: { settles: boolean; value: string } };
      assert.equal(qBody.data.value, "10");
      assert.equal(qBody.data.settles, false);
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });
});
