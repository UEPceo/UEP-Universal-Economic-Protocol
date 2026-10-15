import test from "node:test";
import assert from "node:assert/strict";
import { displayIndicative, displayAllIndicative, renderIndicativePage, INDICATIVE_SOURCES } from "./indicative-display.ts";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";

const now = () => new Date("2026-10-15T08:00:00.000Z");
const reply = (body: unknown, status = 200, redirectTo?: string) => (async (url: string) => ({ ok: status >= 200 && status < 300, status, url: redirectTo ?? url, json: async () => body })) as unknown as typeof fetch;

test("parsers: ECB SDMX-JSON, Eurostat JSON-stat", async () => {
  const sdmx = { dataSets: [{ series: { "0:0:0:0:0": { observations: { "0": [1.0921] } } } }], structure: { dimensions: { observation: [{ values: [{ id: "2026-10-14" }] }] } } };
  const ecb = await displayIndicative("ECB", { fetch: reply(sdmx), now });
  assert.deepEqual([ecb.available, ecb.value, ecb.period], [true, "1.0921", "2026-10-14"]);
  assert.match(ecb.attribution, /Banco Central Europeo/);
  const es = await displayIndicative("EUROSTAT", { fetch: reply({ value: { "0": 2.1 }, dimension: { time: { category: { index: { "2026-09": 0 } } } } }), now });
  assert.deepEqual([es.value, es.period], ["2.1", "2026-09"]);
});

test("0.5.83 compat: removed source id is accepted, never fetched, never available", async () => {
  let calls = 0;
  const spy = (async () => { calls++; throw new Error("must not be called"); }) as unknown as typeof fetch;
  const v = await displayIndicative("WORLDBANK", { fetch: spy, now });
  assert.equal(calls, 0);
  assert.deepEqual([v.available, v.value, (v as { removed?: boolean }).removed], [false, null, true]);
  assert.ok(!Object.keys(INDICATIVE_SOURCES).includes("WORLDBANK"));
  assert.ok(Object.values(INDICATIVE_SOURCES).every((s) => !/worldbank/i.test(s.url)));
});

test("every source down, HTTP error, bad body or off-origin redirect: 'no disponible', never throws", async () => {
  const down = (async () => { throw new Error("down"); }) as typeof fetch;
  const views = await displayAllIndicative({ fetch: down, now });
  assert.equal(views.length, 3);
  assert.ok(views.every((v) => !v.available && v.value === null && v.queriedAt === "2026-10-15T08:00:00.000Z"));
  assert.match(renderIndicativePage(views), /no disponible/);
  assert.equal((await displayIndicative("BIS", { fetch: reply({}, 503), now })).available, false);
  assert.equal((await displayIndicative("BIS", { fetch: reply({ nope: 1 }), now })).available, false);
  const sdmx = { dataSets: [{ series: { a: { observations: { "0": [1.1] } } } }] };
  assert.equal((await displayIndicative("ECB", { fetch: reply(sdmx), now })).available, true);
  const redirected = await displayIndicative("ECB", { fetch: reply(sdmx, 200, "https://evil.example/x"), now });
  assert.equal(redirected.available, false);
  assert.match(redirected.note, /Redirección/);
  for (const s of Object.values(INDICATIVE_SOURCES)) assert.ok(s.attribution.startsWith("Fuente:"));
});

test("HTTP route serves the display with every source down and marks it display-only", async () => {
  const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]) });
  const { server, port } = await listenUepHttpApi({ api, indicativeDisplay: { now, fetch: (async () => { throw new Error("down"); }) as typeof fetch } });
  try {
    const page = await fetch(`http://127.0.0.1:${port}/v1/display/indicators`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /no disponible/);
    const json = await fetch(`http://127.0.0.1:${port}/v1/display/indicators.json`);
    const body = await json.json() as { displayOnly: boolean; entersState: boolean; data: unknown[] };
    assert.equal(body.displayOnly, true);
    assert.equal(body.entersState, false);
    assert.equal(body.data.length, 3);
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});
