import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { displayLei, renderLeiDisplayPage } from "./gleif-display.ts";

const ISSUED = "5493001KJTIIGC8Y1R12";

function jsonResponse(body: unknown, status = 200, url = "https://api.gleif.org/api/v1/lei-records/5493001KJTIIGC8Y1R12"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/vnd.api+json" } });
}

test("GLEIF display: invalid checksum never calls the network", async () => {
  let called = 0;
  const view = await displayLei("5493001KJTIIGC8Y1R13", {
    now: () => new Date("2026-10-09T10:00:00.000Z"),
    fetch: (async () => {
      called += 1;
      return jsonResponse({});
    }) as typeof fetch,
  });
  assert.equal(called, 0);
  assert.equal(view.checksumValid, false);
  assert.equal(view.available, false);
  assert.equal(view.queriedAt, "2026-10-09T10:00:00.000Z");
  assert.equal(view.legalName, null);
});

test("GLEIF display: a registry answer is labelled and dated, and stays out of state", async () => {
  const view = await displayLei(ISSUED, {
    now: () => new Date("2026-10-09T10:01:00.000Z"),
    fetch: (async () => jsonResponse({
      data: { attributes: { entity: { legalName: { name: "EXAMPLE ENTITY" } }, registration: { status: "ISSUED" } } },
    })) as typeof fetch,
  });
  assert.equal(view.available, true);
  assert.equal(view.source, "gleif");
  assert.equal(view.legalName, "EXAMPLE ENTITY");
  assert.equal(view.registrationStatus, "ISSUED");
  assert.equal(view.queriedAt, "2026-10-09T10:01:00.000Z");
  assert.match(view.note, /not ledger state/);
});

test("GLEIF display: a dead registry leaves the checksum and the query time", async () => {
  const view = await displayLei(ISSUED, {
    now: () => new Date("2026-10-09T10:02:00.000Z"),
    fetch: (async () => {
      throw new Error("offline");
    }) as typeof fetch,
  });
  assert.equal(view.checksumValid, true);
  assert.equal(view.available, false);
  assert.equal(view.source, "offline");
  assert.equal(view.queriedAt, "2026-10-09T10:02:00.000Z");
  assert.match(view.note, /continues without it/);
});

test("GLEIF display: a redirect off api.gleif.org is ignored", async () => {
  const foreign = await displayLei(ISSUED, {
    fetch: (async () => ({
      ok: true,
      url: "https://evil.example/lei",
      json: async () => ({ data: { attributes: { entity: { legalName: { name: "X" } } } } }),
    })) as unknown as typeof fetch,
  });
  assert.equal(foreign.available, false);
  assert.equal(foreign.checksumValid, true);
  assert.match(foreign.note, /redirect/);
});

test("GLEIF display page shows the query time and still renders without a name", () => {
  const html = renderLeiDisplayPage({
    lei: ISSUED,
    checksumValid: true,
    queriedAt: "2026-10-09T10:02:00.000Z",
    source: "offline",
    available: false,
    legalName: null,
    registrationStatus: null,
    gleifUrl: null,
    note: "Registry unreachable",
  }, ISSUED);
  assert.match(html, /2026-10-09T10:02:00.000Z/);
  assert.match(html, /no disponible/);
  assert.doesNotMatch(html, /<script/);
});

test("GLEIF display is not imported by the ledger or the policy gate", () => {
  const ledger = fs.readFileSync(new URL("../testnet/ledger.ts", import.meta.url), "utf8");
  const gate = fs.readFileSync(new URL("../oracle/policy-gate.ts", import.meta.url), "utf8");
  assert.equal(ledger.includes("gleif"), false);
  assert.equal(gate.includes("gleif"), false);
});
