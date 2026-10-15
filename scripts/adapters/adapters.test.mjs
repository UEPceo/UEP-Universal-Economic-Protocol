// 0.5.83: offline tests for the off-node source adapters. Recorded fixtures
// only; global fetch is replaced so any accidental network call fails.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fetchBytes, scaled, nfc, SourceError } from "./lib.mjs";
import { parseUsgs, parseGeofon, seismicClaimFromBytes, compareSources, fetchSeismic, SEISMIC_SOURCES } from "./seismic.mjs";
import { CELESTRAK_MIN_INTERVAL_MS, CelestrakClient, LAB_PARSERS, LAB_SOURCES, fetchLab } from "./lab-sources.mjs";
import { canonicalEvidenceClaim } from "../../src/marketplace/evidence.ts";

globalThis.fetch = () => { throw new Error("network disabled in adapter tests"); };
const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const USGS = fx("usgs-2026-10-15.json"), GEOFON = fx("geofon-2026-10-15.txt");
const LAB = { lab: true };
const ok = (bytes) => async () => ({ status: 200, arrayBuffer: async () => bytes });
const hang = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));

// Fiji M5.9 event of 2026-10-14 10:49:48 UTC, reported by both sources.
const FIJI = { minMagnitudeTenths: 55, latMinMicro: -22_000_000, latMaxMicro: -20_000_000, lonMinMicro: -179_500_000, lonMaxMicro: -178_000_000, fromHeight: 1000, toHeight: 1100, fromMs: Date.UTC(2026, 9, 14, 10), toMs: Date.UTC(2026, 9, 14, 12) };

test("USGS and GEOFON fixtures normalize to sorted integer events", () => {
  const u = parseUsgs(USGS), g = parseGeofon(GEOFON);
  assert.equal(u.length, 3); assert.equal(g.length, 3);
  const fu = u.find((e) => e.eventId === "us6000u28y");
  assert.deepEqual(fu, { origin: "USGS", eventId: "us6000u28y", timeMs: 1791974987588, latMicro: -20989900, lonMicro: -178771100, magHundredths: 590, magType: "mww" });
  const fg = g.find((e) => e.eventId === "gfz2026udji");
  assert.deepEqual(fg, { origin: "GEOFON", eventId: "gfz2026udji", timeMs: Date.UTC(2026, 9, 14, 10, 49, 48, 80), latMicro: -21030000, lonMicro: -178857000, magHundredths: 592, magType: "Mw" });
  for (const ev of [...u, ...g]) for (const k of ["timeMs", "latMicro", "lonMicro", "magHundredths"]) assert.ok(Number.isSafeInteger(ev[k]));
  assert.deepEqual(parseUsgs(USGS), u, "deterministic");
});

test("each seismic source emits the 0.5.82 canonical SEISMIC claim, ready for attesters", () => {
  const a = seismicClaimFromBytes("USGS", USGS, FIJI), b = seismicClaimFromBytes("GEOFON", GEOFON, FIJI);
  const { fromMs, toMs, ...claim } = FIJI;
  const canonical = canonicalEvidenceClaim({ kind: "SEISMIC", ...claim });
  for (const r of [a, b]) {
    assert.equal(r.canonicalClaim, canonical);
    assert.equal(r.claimHash, createHash("sha256").update(canonical).digest("hex"));
    assert.equal(r.matches.length, 1);
    assert.ok(!r.canonicalClaim.includes("Ms") && !("fromMs" in r.claim), "source time never enters the claim");
  }
  assert.equal(b.attribution, "Event locations were obtained from the GEOFON program of the GFZ Helmholtz Centre for Geosciences using data from the GEVN partner networks.");
  assert.match(b.licence, /^CC BY 4.0 \(event products/);
  assert.notEqual(a.sourceId, b.sourceId);
});

test("agreement stays undecided: tolerances are residual (30-day study)", () => {
  const a = seismicClaimFromBytes("USGS", USGS, FIJI), b = seismicClaimFromBytes("GEOFON", GEOFON, FIJI);
  assert.throws(() => compareSources(a, b), /EVIDENCE_TOLERANCES_UNSET/);
  assert.throws(() => compareSources(a, a), /SOURCES_NOT_DISTINCT/);
});

test("discrepant sources: magnitude threshold between the two readings", () => {
  const q = { ...FIJI, minMagnitudeTenths: 60 }; // USGS 5.90 < 6.0; GEOFON 5.92 < 6.0 -> both none
  assert.equal(compareSources(seismicClaimFromBytes("USGS", USGS, q), seismicClaimFromBytes("GEOFON", GEOFON, q)).status, "NO_EVIDENCE");
  // Box that contains the GEOFON epicentre (-178.857) but not the USGS one (-178.7711).
  const box = { ...FIJI, lonMinMicro: -179_000_000, lonMaxMicro: -178_800_000 };
  const r = compareSources(seismicClaimFromBytes("USGS", USGS, box), seismicClaimFromBytes("GEOFON", GEOFON, box));
  assert.equal(r.status, "SOURCES_DISCREPANT");
});

test("malformed data is refused (no partial evidence)", () => {
  const bad = (s) => Buffer.from(s);
  assert.throws(() => parseUsgs(bad("{")), /SOURCE_MALFORMED/);
  assert.throws(() => parseUsgs(bad('{"type":"Feature"}')), /SOURCE_MALFORMED/);
  const j = JSON.parse(USGS);
  j.features[0].properties.mag = "5.9x"; assert.throws(() => parseUsgs(Buffer.from(JSON.stringify(j))), /SOURCE_MALFORMED/);
  j.features[0].properties.mag = null; assert.throws(() => parseUsgs(Buffer.from(JSON.stringify(j))), /without magnitude/);
  const dup = JSON.parse(USGS); dup.features.push(dup.features[0]); assert.throws(() => parseUsgs(Buffer.from(JSON.stringify(dup))), /duplicate/);
  const lat = JSON.parse(USGS); lat.features[0].geometry.coordinates[1] = 91; assert.throws(() => parseUsgs(Buffer.from(JSON.stringify(lat))), /range/);
  assert.throws(() => parseUsgs(Buffer.from([0x7b, 0xff, 0x7d])), /invalid UTF-8/);
  const g = GEOFON.toString();
  assert.throws(() => parseGeofon(bad(g.replace("#EventID", "#Event"))), /header/);
  assert.throws(() => parseGeofon(bad(g.replace("|Mw|5.92|", "|Mw|5,92|"))), /SOURCE_MALFORMED/);
  assert.throws(() => parseGeofon(bad(g.replace("2026-10-14T10:49:48.08", "14/10/2026"))), /SOURCE_MALFORMED/);
  assert.throws(() => parseGeofon(bad(g + "x|y\n")), /column count/);
  assert.throws(() => seismicClaimFromBytes("EMSC", USGS, FIJI), /SOURCE_UNKNOWN/);
  assert.throws(() => seismicClaimFromBytes("USGS", USGS, { ...FIJI, latMinMicro: 1, latMaxMicro: 0 }), /EVIDENCE_CLAIM_INVALID/);
});

test("normalization: NFC, no trim, no case folding, BigInt decimals", () => {
  assert.equal(nfc("Cafe\u0301", "x"), "Caf\u00e9");
  assert.equal(nfc(" Mw ", "x"), " Mw ");
  assert.equal(nfc("MW", "x"), "MW");
  assert.throws(() => nfc("\ud800", "x"), /well-formed/);
  assert.equal(scaled("-178.8567", 6, "x"), -178856700);
  assert.equal(scaled("1.210000000000000e+002", 1, "x"), 1210);
  assert.equal(scaled("-9.135334044270255E+06", 3, "x"), -9135334044);
  assert.equal(scaled("0.1234567", 6, "x"), 123456, "truncated toward zero");
  assert.equal(scaled("-0.0000001", 6, "x"), 0);
  for (const v of ["", "1e", "0x10", "1,5", " 1", "NaN", Infinity]) assert.throws(() => scaled(v, 2, "x"), /SOURCE_MALFORMED/);
});

test("timeout and unavailable sources yield an error, never evidence", async () => {
  await assert.rejects(fetchBytes("https://example.invalid/", { timeoutMs: 50, fetchImpl: hang }), /SOURCE_TIMEOUT/);
  await assert.rejects(fetchBytes("https://example.invalid/", { fetchImpl: async () => ({ status: 503 }) }), /SOURCE_UNAVAILABLE: HTTP 503/);
  await assert.rejects(fetchBytes("https://example.invalid/", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), /SOURCE_UNAVAILABLE/);
  await assert.rejects(fetchSeismic("GEOFON", FIJI, { timeoutMs: 50, fetchImpl: hang }), /SOURCE_TIMEOUT/);
  const r = await fetchSeismic("USGS", FIJI, { fetchImpl: ok(USGS) });
  assert.ok(r.url.startsWith(SEISMIC_SOURCES.USGS.endpoint) && r.claimHash);
});

const LAB_FIXTURES = { SWPC_KP: "swpc-kp-2026-10-15.json", SWPC_F107: "swpc-f107-2026-10-15.json", HORIZONS: "horizons-mars-2026-10-15.json", CELESTRAK: "celestrak-25544-2026-10-15.json", DSN: "dsn-2026-10-15.xml", OPEN_METEO: "openmeteo-madrid-2026-10-15.json" };

test("lab adapters refuse to run without the explicit lab flag", async () => {
  const prev = process.env.UEP_LAB_SOURCES; delete process.env.UEP_LAB_SOURCES;
  try {
    for (const [k, f] of Object.entries(LAB_FIXTURES)) assert.throws(() => LAB_PARSERS[k](fx(f)), /LAB_FLAG_REQUIRED/);
    await assert.rejects(fetchLab("SWPC_KP", "", { fetchImpl: ok(fx(LAB_FIXTURES.SWPC_KP)) }), /LAB_FLAG_REQUIRED/);
  } finally { if (prev !== undefined) process.env.UEP_LAB_SOURCES = prev; }
});

test("lab fixtures normalize deterministically to integers, with licence and attribution", () => {
  for (const [k, f] of Object.entries(LAB_FIXTURES)) {
    const r = LAB_PARSERS[k](fx(f), LAB);
    assert.equal(r.lab, true); assert.equal(r.account, false); assert.ok(r.licence && r.attribution);
    assert.ok(r.records.length > 0, k);
    assert.deepEqual(LAB_PARSERS[k](fx(f), LAB), r);
  }
  assert.equal(LAB_SOURCES.OPEN_METEO.nonCommercialOnly, true);
  const om = LAB_PARSERS.OPEN_METEO(fx(LAB_FIXTURES.OPEN_METEO), LAB).records[0];
  assert.deepEqual(om, { timeMs: Date.UTC(2026, 9, 15, 11, 45), latMicro: 40417583, lonMicro: -3739399, temperatureTenthsC: 234, windTenthsKmh: 52 });
  const hz = LAB_PARSERS.HORIZONS(fx(LAB_FIXTURES.HORIZONS), LAB).records;
  assert.deepEqual(hz[0], { jdTdbMicro: 2461328500000, xM: -9135334044, yM: 235404838123, zM: 5157221787 });
  assert.equal(LAB_PARSERS.CELESTRAK(fx(LAB_FIXTURES.CELESTRAK), LAB).records[0].noradId, 25544);
  assert.ok(LAB_PARSERS.DSN(fx(LAB_FIXTURES.DSN), LAB).records.some((d) => d.dish === "DSS14"));
  assert.ok(LAB_PARSERS.SWPC_F107(fx(LAB_FIXTURES.SWPC_F107), LAB).records.some((r) => r.fluxTenthsSfu === 1210));
});

test("lab adapters refuse malformed data, timeouts and down sources", async () => {
  const b = (s) => Buffer.from(s);
  assert.throws(() => LAB_PARSERS.SWPC_KP(b('[{"time_tag":"2026-10-08T00:00:00","Kp":12}]'), LAB), /Kp range/);
  assert.throws(() => LAB_PARSERS.SWPC_KP(b("[]"), LAB), /SOURCE_MALFORMED/);
  assert.throws(() => LAB_PARSERS.SWPC_F107(b('[{"time_tag":"2026-10-14T22:00:00","frequency":2700,"flux":121}]'), LAB), /frequency/);
  assert.throws(() => LAB_PARSERS.HORIZONS(b('{"result":"no data"}'), LAB), /ephemeris/);
  assert.throws(() => LAB_PARSERS.CELESTRAK(b('[{"NORAD_CAT_ID":"25544"}]'), LAB), /NORAD/);
  assert.throws(() => LAB_PARSERS.DSN(b("<html></html>"), LAB), /DSN/);
  const om = JSON.parse(fx(LAB_FIXTURES.OPEN_METEO)); om.utc_offset_seconds = 7200;
  assert.throws(() => LAB_PARSERS.OPEN_METEO(b(JSON.stringify(om)), LAB), /UTC expected/);
  await assert.rejects(fetchLab("DSN", "", { lab: true, timeoutMs: 50, fetchImpl: hang }), /SOURCE_TIMEOUT/);
  await assert.rejects(fetchLab("OPEN_METEO", "latitude=40&longitude=-3", { lab: true, fetchImpl: async () => ({ status: 429 }) }), /HTTP 429/);
  const r = await fetchLab("CELESTRAK", "CATNR=25544&FORMAT=json", { lab: true, celestrak: new CelestrakClient({ nowMs: () => 0 }), fetchImpl: ok(fx(LAB_FIXTURES.CELESTRAK)) });
  assert.equal(r.records[0].noradId, 25544);
});

test("excluded sources are not present", () => {
  const all = JSON.stringify({ SEISMIC_SOURCES, LAB_SOURCES }).toLowerCase();
  for (const s of ["emsc", "seismicportal", "iers", "leap", "iana", "coingecko", "weather.gov", "imf.org", "openaq", "copernicus"]) assert.ok(!all.includes(s), s);
  for (const s of Object.values({ ...SEISMIC_SOURCES, ...LAB_SOURCES })) assert.equal(s.account, false);
  assert.ok(SourceError);
});

test("CelesTrak usage policy: OMM JSON only, one download per 2-hour update, hard stop on non-200", async () => {
  let calls = 0, now = 1_000_000;
  const counting = (status, body) => async () => { calls++; return status === 200 ? { status: 200, arrayBuffer: async () => body } : { status }; };
  const c = new CelestrakClient({ nowMs: () => now });
  // TLE formats and a missing format are refused before any request.
  await assert.rejects(c.fetch("CATNR=25544&FORMAT=tle", { lab: true, fetchImpl: counting(200) }), /CELESTRAK_TLE_FORBIDDEN/);
  await assert.rejects(c.fetch("CATNR=25544&FORMAT=3LE", { lab: true, fetchImpl: counting(200) }), /CELESTRAK_TLE_FORBIDDEN/);
  await assert.rejects(c.fetch("CATNR=25544", { lab: true, fetchImpl: counting(200) }), /CELESTRAK_FORMAT_REQUIRED/);
  assert.equal(calls, 0);
  const body = fx(LAB_FIXTURES.CELESTRAK);
  const a = await c.fetch("CATNR=25544&FORMAT=json", { lab: true, fetchImpl: counting(200, body) });
  assert.equal(a.cached, false);
  // Same query (parameter order irrelevant) within 2 hours: served from cache, no request.
  now += CELESTRAK_MIN_INTERVAL_MS - 1;
  const b2 = await c.fetch("FORMAT=json&CATNR=25544", { lab: true, fetchImpl: counting(200, body) });
  assert.equal(b2.cached, true); assert.equal(calls, 1);
  // After the update interval: one new download.
  now += 1;
  await c.fetch("CATNR=25544&FORMAT=json", { lab: true, fetchImpl: counting(200, body) });
  assert.equal(calls, 2);
  // Any non-200 stops every further query (also other queries) until reset by an operator.
  await assert.rejects(c.fetch("CATNR=99999&FORMAT=json", { lab: true, fetchImpl: counting(403) }), /HTTP 403/);
  assert.ok(c.stopped);
  await assert.rejects(c.fetch("CATNR=11111&FORMAT=json", { lab: true, fetchImpl: counting(200, body) }), /CELESTRAK_STOPPED/);
  assert.equal(calls, 3, "no request after the stop");
  c.resetAfterReview();
  await c.fetch("CATNR=11111&FORMAT=json", { lab: true, fetchImpl: counting(200, body) });
  assert.equal(calls, 4);
  assert.throws(() => new CelestrakClient({ minIntervalMs: 60_000 }), /SOURCE_CONFIG_INVALID/);
});

test("licence notes: GEOFON attribution, DSN CC0 (logos excluded), CelesTrak usage policy", () => {
  assert.equal(SEISMIC_SOURCES.GEOFON.attribution, "Event locations were obtained from the GEOFON program of the GFZ Helmholtz Centre for Geosciences using data from the GEVN partner networks.");
  assert.match(LAB_SOURCES.DSN.licence, /CC0 unless noted/);
  assert.match(LAB_SOURCES.DSN.licence, /logos/);
  assert.match(LAB_SOURCES.CELESTRAK.licence, /usage policy/);
});
