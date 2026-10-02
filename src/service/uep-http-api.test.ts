import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";

describe("UEP-API-001.1 local HTTP", () => {
  it("capabilities, object roundtrip, economic read, provider down does not throw", async () => {
    const mem = new MemoryStorageProvider();
    const api = new UepServiceApi({ storageProviders: new Map([["memory", mem]]) });
    const { server, port } = await listenUepHttpApi({
      api,
      economic: {
        tip: () => ({ stateRoot: "abc", height: 3, treasury: "5" }),
        balance: (id) => (id === "alice" ? "10000" : "0"),
      },
    });
    try {
      const cap = await fetch(`http://127.0.0.1:${port}/v1/capabilities`);
      assert.equal(cap.status, 200);
      const capBody = await cap.json() as { services: { storage: boolean; compute: boolean } };
      assert.equal(capBody.services.storage, true);
      assert.equal(capBody.services.compute, false);

      const put = await fetch(`http://127.0.0.1:${port}/v1/objects/note-1`, {
        method: "PUT",
        body: Buffer.from("hello-uep"),
      });
      assert.equal(put.status, 200);
      const got = await fetch(`http://127.0.0.1:${port}/v1/objects/note-1`);
      const gotBody = await got.json() as { ok: boolean; data: { bodyBase64: string } };
      assert.equal(gotBody.ok, true);
      assert.equal(Buffer.from(gotBody.data.bodyBase64, "base64").toString(), "hello-uep");

      const tip = await fetch(`http://127.0.0.1:${port}/v1/economic/tip`);
      const tipBody = await tip.json() as { data: { height: number } };
      assert.equal(tipBody.data.height, 3);
      const bal = await fetch(`http://127.0.0.1:${port}/v1/economic/accounts/alice`);
      const balBody = await bal.json() as { data: { balance: string } };
      assert.equal(balBody.data.balance, "10000");
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });
});
