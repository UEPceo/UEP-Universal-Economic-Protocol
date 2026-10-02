import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { SpendInbox } from "./uep-service-backends.ts";
import { Groth16SpendQueue } from "./groth16-spend-queue.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";

describe("UEP-API-001.3 spend queue to Groth16", () => {
  it("queued alice spend is proved and applied locally, not marked final", async () => {
    const q = new Groth16SpendQueue(32);
    const inbox = new SpendInbox((input) => Promise.resolve(q.accept(input)));
    const api = new UepServiceApi({
      storageProviders: new Map([["memory", new MemoryStorageProvider()]]),
      spends: inbox,
      groth16: q,
    });
    const { server, port } = await listenUepHttpApi({ api });
    try {
      const queued = await fetch(`http://127.0.0.1:${port}/v1/spends`, {
        method: "POST",
        body: JSON.stringify({
          sender: "alice",
          recipient: "bob",
          amount: "1000",
          nonce: "n1",
          domainId: "lab",
        }),
      });
      assert.equal(queued.status, 202);
      const proved = await fetch(`http://127.0.0.1:${port}/v1/spends/prove`, { method: "POST" });
      const body = await proved.json() as { ok: boolean; data: { final: boolean; spends: { publicInputs: number; newRoot: string }[] } };
      assert.equal(proved.status, 200, JSON.stringify(body));
      assert.equal(body.data.final, false);
      assert.equal(body.data.spends[0]!.publicInputs, 13); // 12 economic publics + domain_id
      assert.equal(body.data.spends[0]!.newRoot.length, 64);
      assert.equal(q.state.balance("bob"), 1000n);
      assert.ok(q.state.balance("alice") < 9000n);
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });
});
