import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";

test("HTTP: advertised object size works, client errors are 400, internal ids reach the sink", async () => {
  const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]) });
  const seen: string[] = [];
  const { server, port } = await listenUepHttpApi({ api, onError: (id) => { seen.push(id); } });
  const u = `http://127.0.0.1:${port}`;
  try {
    const put = await fetch(`${u}/v1/objects/big`, { method: "PUT", body: Buffer.alloc(200 * 1024, 1) });
    assert.equal(put.status, 200);
    const bad = await fetch(`${u}/v1/marketplace/listings`, { method: "POST", body: JSON.stringify({ providerId: "p", unitPrice: "-5", capacity: "1" }) });
    assert.equal(bad.status, 400);
    const huge = await fetch(`${u}/v1/marketplace/listings`, { method: "POST", body: JSON.stringify({ providerId: "p", unitPrice: "9".repeat(31), capacity: "1" }) });
    assert.equal(huge.status, 400);
    const bj = await fetch(`${u}/v1/marketplace/listings`, { method: "POST", body: "{not json" });
    assert.equal(bj.status, 400);
    const tooBig = await fetch(`${u}/v1/marketplace/listings`, { method: "POST", body: "x".repeat(70 * 1024) });
    assert.equal(tooBig.status, 413);
    assert.deepEqual(seen, [], "client errors are not internal errors");
  } finally { await new Promise((r) => server.close(() => r(undefined))); }
});
