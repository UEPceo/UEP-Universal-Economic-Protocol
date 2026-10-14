import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";

test("LEI display route keeps working when GLEIF is down and does not touch the ledger", async () => {
  const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]) });
  const { server, port } = await listenUepHttpApi({
    api,
    leiDisplay: {
      now: () => new Date("2026-10-09T11:00:00.000Z"),
      fetch: (async () => {
        throw new Error("gleif down");
      }) as typeof fetch,
    },
  });
  try {
    const page = await fetch(`http://127.0.0.1:${port}/v1/display/lei?lei=5493001KJTIIGC8Y1R12`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /2026-10-09T11:00:00.000Z/);
    assert.match(html, /no disponible/);
    const json = await fetch(`http://127.0.0.1:${port}/v1/display/lei/5493001KJTIIGC8Y1R12`, { headers: { accept: "application/json" } });
    const body = await json.json() as { displayOnly: boolean; entersState: boolean; data: { available: boolean; queriedAt: string } };
    assert.equal(json.status, 200);
    assert.equal(body.displayOnly, true);
    assert.equal(body.entersState, false);
    assert.equal(body.data.available, false);
    assert.equal(body.data.queriedAt, "2026-10-09T11:00:00.000Z");
    const bad = await fetch(`http://127.0.0.1:${port}/v1/display/lei/00000000000000006500`, { headers: { accept: "application/json" } });
    assert.equal(bad.status, 422);
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});
