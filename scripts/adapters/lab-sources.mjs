// 0.5.83: LAB-ONLY source adapters (off-node). Behind an explicit flag
// (UEP_LAB_SOURCES=1 or { lab: true }); never on a node, never in a policy,
// a quote, a settlement or any state. Interplanetary/space-weather research
// and demos only. Open-Meteo is NON-COMMERCIAL ONLY (its free API terms).
import { SourceError, fetchBytes, isoUtcMs, nfc, parseJson, requireLab, scaled, sha256hex, utf8 } from "./lib.mjs";

export const LAB_SOURCES = Object.freeze({
  SWPC_KP: { sourceId: "noaa-swpc-planetary-k", url: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json", licence: "Public domain (U.S. Government work, NOAA SWPC)", attribution: "NOAA Space Weather Prediction Center", account: false, nonCommercialOnly: false },
  SWPC_F107: { sourceId: "noaa-swpc-f107", url: "https://services.swpc.noaa.gov/json/f107_cm_flux.json", licence: "Public domain (U.S. Government work, NOAA SWPC)", attribution: "NOAA Space Weather Prediction Center", account: false, nonCommercialOnly: false },
  HORIZONS: { sourceId: "jpl-horizons", url: "https://ssd.jpl.nasa.gov/api/horizons.api", licence: "U.S. Government work (NASA/JPL); no account; offline SPK kernels preferred", attribution: "JPL Solar System Dynamics, Horizons On-Line Ephemeris System", account: false, nonCommercialOnly: false },
  CELESTRAK: { sourceId: "celestrak-gp", url: "https://celestrak.org/NORAD/elements/gp.php", licence: "No explicit licence published; lab use with attribution, respect rate limits", attribution: "CelesTrak (T.S. Kelso)", account: false, nonCommercialOnly: false },
  DSN: { sourceId: "nasa-dsn-now", url: "https://eyes.nasa.gov/dsn/data/dsn.xml", licence: "NASA public data (no explicit licence on the feed); lab use with attribution", attribution: "NASA Deep Space Network (DSN Now)", account: false, nonCommercialOnly: false },
  OPEN_METEO: { sourceId: "open-meteo-forecast", url: "https://api.open-meteo.com/v1/forecast", licence: "CC BY 4.0 data; free API for NON-COMMERCIAL use only (<10,000 calls/day)", attribution: "Weather data by Open-Meteo.com (CC BY 4.0)", account: false, nonCommercialOnly: true },
});

const out = (key, bytes, records) => ({ lab: true, ...LAB_SOURCES[key], dataHash: sha256hex(bytes), records });
const arr = (v, what) => { if (!Array.isArray(v) || v.length === 0) throw new SourceError("SOURCE_MALFORMED", what); return v; };

/** Kp index: [{time_tag, Kp}] -> {timeMs, kpHundredths}. */
export function parseSwpcKp(bytes, opts) {
  requireLab(opts);
  const rows = arr(parseJson(bytes), "Kp array").map((r) => {
    const kp = scaled(r?.Kp, 2, "Kp");
    if (kp < 0 || kp > 900) throw new SourceError("SOURCE_MALFORMED", "Kp range");
    return { timeMs: isoUtcMs(r.time_tag, "time_tag"), kpHundredths: kp };
  });
  return out("SWPC_KP", bytes, rows.sort((a, b) => a.timeMs - b.timeMs));
}

/** F10.7 cm flux: [{time_tag, frequency: 2800, flux}] -> {timeMs, fluxTenthsSfu}. */
export function parseSwpcF107(bytes, opts) {
  requireLab(opts);
  const rows = arr(parseJson(bytes), "flux array").map((r) => {
    if (r?.frequency !== 2800) throw new SourceError("SOURCE_MALFORMED", "frequency");
    const flux = scaled(r.flux, 1, "flux");
    if (flux <= 0 || flux > 10_000) throw new SourceError("SOURCE_MALFORMED", "flux range");
    return { timeMs: isoUtcMs(r.time_tag, "time_tag"), fluxTenthsSfu: flux, schedule: nfc(r.reporting_schedule ?? "", "reporting_schedule") };
  });
  return out("SWPC_F107", bytes, rows.sort((a, b) => a.timeMs - b.timeMs || (a.schedule < b.schedule ? -1 : 1)));
}

/** Horizons VECTORS, CSV: rows between $$SOE/$$EOE -> {jdTdbMicro, xM, yM, zM} (metres, integers). */
export function parseHorizons(bytes, opts) {
  requireLab(opts);
  const d = parseJson(bytes);
  if (typeof d?.result !== "string") throw new SourceError("SOURCE_MALFORMED", "result");
  const r = nfc(d.result, "result");
  const a = r.indexOf("$$SOE\n"), b = r.indexOf("$$EOE");
  if (a < 0 || b < a) throw new SourceError("SOURCE_MALFORMED", "no ephemeris block");
  const rows = r.slice(a + 6, b).split("\n").filter((l) => l !== "").map((l) => {
    const f = l.split(",").map((x) => x.replace(/^ +| +$/g, "")); // CSV column padding only; values are not altered
    if (f.length < 5) throw new SourceError("SOURCE_MALFORMED", "row");
    return { jdTdbMicro: scaled(f[0], 6, "JDTDB"), xM: scaled(f[2], 3, "X"), yM: scaled(f[3], 3, "Y"), zM: scaled(f[4], 3, "Z") };
  });
  return out("HORIZONS", bytes, arr(rows, "rows"));
}

/** CelesTrak GP JSON -> orbital elements as scaled integers. */
export function parseCelestrak(bytes, opts) {
  requireLab(opts);
  const rows = arr(parseJson(bytes), "GP array").map((g) => {
    if (!Number.isSafeInteger(g?.NORAD_CAT_ID)) throw new SourceError("SOURCE_MALFORMED", "NORAD_CAT_ID");
    return { noradId: g.NORAD_CAT_ID, name: nfc(g.OBJECT_NAME, "OBJECT_NAME"), epochMs: isoUtcMs(g.EPOCH, "EPOCH"), meanMotionE8: scaled(g.MEAN_MOTION, 8, "MEAN_MOTION"), eccentricityE8: scaled(g.ECCENTRICITY, 8, "ECCENTRICITY"), inclinationE4: scaled(g.INCLINATION, 4, "INCLINATION") };
  });
  return out("CELESTRAK", bytes, rows.sort((a, b) => a.noradId - b.noradId));
}

/** DSN Now XML -> dishes and their targets (name, round-trip light time in ms; -1 = none). */
export function parseDsn(bytes, opts) {
  requireLab(opts);
  const x = nfc(utf8(bytes), "xml");
  if (!/^\s*<dsn>[\s\S]*<\/dsn>\s*$/.test(x)) throw new SourceError("SOURCE_MALFORMED", "not a DSN document");
  const dishes = [];
  for (const m of x.matchAll(/<dish name="([A-Z0-9]{2,8})"[^>]*>([\s\S]*?)<\/dish>/g)) {
    const targets = [...m[2].matchAll(/<target name="([^"]*)" id="(-?\d+)" uplegRange="[^"]*" downlegRange="[^"]*" rtlt="([^"]*)"\/>/g)]
      .map((t) => ({ name: t[1], id: Number(t[2]), rtltMs: t[3] === "-1" ? -1 : scaled(t[3], 3, "rtlt") }));
    dishes.push({ dish: m[1], targets });
  }
  return out("DSN", bytes, arr(dishes, "dishes").sort((a, b) => (a.dish < b.dish ? -1 : 1)));
}

/** Open-Meteo current conditions. NON-COMMERCIAL ONLY. */
export function parseOpenMeteo(bytes, opts) {
  requireLab(opts);
  const d = parseJson(bytes);
  const c = d?.current;
  if (!c || typeof c.time !== "string" || d.utc_offset_seconds !== 0) throw new SourceError("SOURCE_MALFORMED", "current (UTC expected)");
  if (d.current_units?.temperature_2m !== "°C") throw new SourceError("SOURCE_MALFORMED", "units");
  return out("OPEN_METEO", bytes, [{ timeMs: isoUtcMs(c.time + ":00", "time"), latMicro: scaled(d.latitude, 6, "latitude"), lonMicro: scaled(d.longitude, 6, "longitude"), temperatureTenthsC: scaled(c.temperature_2m, 1, "temperature_2m"), windTenthsKmh: scaled(c.wind_speed_10m, 1, "wind_speed_10m") }]);
}

export const LAB_PARSERS = { SWPC_KP: parseSwpcKp, SWPC_F107: parseSwpcF107, HORIZONS: parseHorizons, CELESTRAK: parseCelestrak, DSN: parseDsn, OPEN_METEO: parseOpenMeteo };

/** Fetch + parse one lab source. `query` is the URL query string (e.g. CATNR=25544&FORMAT=json). */
export async function fetchLab(key, query = "", opts = {}) {
  requireLab(opts);
  const src = LAB_SOURCES[key];
  if (!src) throw new SourceError("SOURCE_UNKNOWN", key);
  const { bytes, url } = await fetchBytes(query ? `${src.url}?${query}` : src.url, opts);
  return { url, ...LAB_PARSERS[key](bytes, opts) };
}
