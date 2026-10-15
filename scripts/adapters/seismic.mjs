// 0.5.83: USGS and GEOFON seismic adapters (off-node, phase 2.3 preparation).
// Each parses one source into normalized integer events and, for a requested
// claim, emits the canonical SEISMIC claim of 0.5.82 (`canonicalEvidenceClaim`)
// plus its hash, ready for attesters to sign. NOT wired to settlement: the
// cross-source tolerances are residual (30-day study) and `compareSources`
// refuses to decide agreement while they are unset.
import { canonicalEvidenceClaim, checkClaimAgreement, CLAIM_TOLERANCES } from "../../src/marketplace/evidence.ts";
import { SourceError, fetchBytes, isoUtcMs, nfc, parseJson, scaled, sha256hex, utf8 } from "./lib.mjs";

export const SEISMIC_SOURCES = Object.freeze({
  USGS: {
    sourceId: "usgs-fdsnws-event",
    endpoint: "https://earthquake.usgs.gov/fdsnws/event/1/query",
    licence: "Public domain (U.S. Government work)",
    attribution: "U.S. Geological Survey, Earthquake Hazards Program",
    account: false,
  },
  GEOFON: {
    sourceId: "geofon-fdsnws-event",
    endpoint: "https://geofon.gfz.de/fdsnws/event/1/query",
    licence: "CC BY 4.0",
    attribution: "GEOFON Data Centre, GFZ Helmholtz Centre Potsdam (CC BY 4.0)",
    account: false,
  },
});

const EVENT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
function event(origin, eventId, timeMs, lat, lon, mag, magType) {
  const id = nfc(eventId, "eventId");
  if (!EVENT_ID.test(id)) throw new SourceError("SOURCE_MALFORMED", "eventId");
  const e = { origin, eventId: id, timeMs, latMicro: scaled(lat, 6, "lat"), lonMicro: scaled(lon, 6, "lon"), magHundredths: scaled(mag, 2, "mag"), magType: nfc(magType, "magType") };
  if (Math.abs(e.latMicro) > 90_000_000 || Math.abs(e.lonMicro) > 180_000_000 || e.magHundredths < -200 || e.magHundredths > 1200) throw new SourceError("SOURCE_MALFORMED", "range");
  return e;
}
const order = (a, b) => (a.timeMs - b.timeMs) || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);

/** USGS FDSN GeoJSON. */
export function parseUsgs(bytes) {
  const d = parseJson(bytes);
  if (d?.type !== "FeatureCollection" || !Array.isArray(d.features)) throw new SourceError("SOURCE_MALFORMED", "not a FeatureCollection");
  const seen = new Set();
  const out = d.features.map((f) => {
    const p = f?.properties, c = f?.geometry?.coordinates;
    if (f?.type !== "Feature" || !p || !Array.isArray(c) || c.length < 2 || !Number.isSafeInteger(p.time)) throw new SourceError("SOURCE_MALFORMED", "feature");
    if (p.mag === null || p.mag === undefined) throw new SourceError("SOURCE_MALFORMED", "feature without magnitude");
    const e = event("USGS", f.id, p.time, c[1], c[0], p.mag, p.magType ?? "");
    if (seen.has(e.eventId)) throw new SourceError("SOURCE_MALFORMED", "duplicate event");
    seen.add(e.eventId);
    return e;
  });
  return out.sort(order);
}

const GEOFON_HEADER = "#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType";
/** GEOFON FDSN text format (pipe-separated, fixed header). */
export function parseGeofon(bytes) {
  const lines = utf8(bytes).split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== GEOFON_HEADER) throw new SourceError("SOURCE_MALFORMED", "unexpected header");
  const seen = new Set();
  const out = lines.slice(1).map((line) => {
    const f = line.split("|");
    if (f.length !== 14) throw new SourceError("SOURCE_MALFORMED", "column count");
    const e = event("GEOFON", f[0], isoUtcMs(f[1], "time"), f[2], f[3], f[10], f[9]);
    if (seen.has(e.eventId)) throw new SourceError("SOURCE_MALFORMED", "duplicate event");
    seen.add(e.eventId);
    return e;
  });
  return out.sort(order);
}

export const PARSERS = { USGS: parseUsgs, GEOFON: parseGeofon };

/**
 * Build the attester output for one source and one requested claim.
 * `query` = { minMagnitudeTenths, latMinMicro, latMaxMicro, lonMinMicro, lonMaxMicro,
 *             fromHeight, toHeight, fromMs, toMs }.
 * fromMs/toMs is the attester's own mapping of the height window to source
 * time; it stays outside the claim (only heights are signed).
 */
export function seismicClaimFromBytes(origin, bytes, query) {
  const src = SEISMIC_SOURCES[origin];
  if (!src) throw new SourceError("SOURCE_UNKNOWN", origin);
  if (!Number.isSafeInteger(query.fromMs) || !Number.isSafeInteger(query.toMs) || query.toMs < query.fromMs) throw new SourceError("SOURCE_CONFIG_INVALID", "time window");
  const claim = { kind: "SEISMIC", minMagnitudeTenths: query.minMagnitudeTenths, latMinMicro: query.latMinMicro, latMaxMicro: query.latMaxMicro, lonMinMicro: query.lonMinMicro, lonMaxMicro: query.lonMaxMicro, fromHeight: query.fromHeight, toHeight: query.toHeight };
  const canonical = canonicalEvidenceClaim(claim);
  const events = PARSERS[origin](bytes);
  const matches = events.filter((e) => e.magHundredths >= claim.minMagnitudeTenths * 10 && e.latMicro >= claim.latMinMicro && e.latMicro <= claim.latMaxMicro && e.lonMicro >= claim.lonMinMicro && e.lonMicro <= claim.lonMaxMicro && e.timeMs >= query.fromMs && e.timeMs <= query.toMs);
  return {
    origin, sourceId: src.sourceId, licence: src.licence, attribution: src.attribution,
    dataHash: sha256hex(bytes),
    // Only when the source reports a matching event does an attester have a claim to sign.
    claim: matches.length ? claim : null,
    canonicalClaim: matches.length ? canonical : null,
    claimHash: matches.length ? sha256hex(Buffer.from(canonical)) : null,
    matches,
  };
}

/**
 * Compare two sources' outputs for the same claim. Structural discrepancy
 * (one asserts, the other does not) is reported as SOURCES_DISCREPANT; value
 * agreement needs the tolerances, which are RESIDUAL: it throws
 * EVIDENCE_TOLERANCES_UNSET. Nothing here settles anything.
 */
export function compareSources(a, b, tolerances = CLAIM_TOLERANCES) {
  if (a.origin === b.origin || a.sourceId === b.sourceId) throw new SourceError("SOURCES_NOT_DISTINCT");
  if ((a.claimHash === null) !== (b.claimHash === null)) return { status: "SOURCES_DISCREPANT", reason: "one source reports a matching event, the other none" };
  if (a.claimHash === null) return { status: "NO_EVIDENCE" };
  if (a.claimHash !== b.claimHash) return { status: "SOURCES_DISCREPANT", reason: "different claims" };
  checkClaimAgreement(tolerances); // throws while the 30-day study is pending
  return { status: "CLAIM_AGREED" };
}

export async function fetchSeismic(origin, query, opts = {}) {
  const src = SEISMIC_SOURCES[origin];
  if (!src) throw new SourceError("SOURCE_UNKNOWN", origin);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 23);
  const minMag = (query.minMagnitudeTenths / 10).toFixed(1);
  const qs = origin === "USGS"
    ? `format=geojson&starttime=${iso(query.fromMs)}&endtime=${iso(query.toMs)}&minmagnitude=${minMag}&orderby=time-asc&limit=200`
    : `format=text&start=${iso(query.fromMs)}&end=${iso(query.toMs)}&minmag=${minMag}&limit=200`;
  const { bytes, url } = await fetchBytes(`${src.endpoint}?${qs}`, opts);
  return { url, ...seismicClaimFromBytes(origin, bytes, query) };
}
