#!/usr/bin/env node
// Example off-node adapter (0.5.82): fetch a USGS GeoJSON feed and print the
// unsigned evidence statement body. Usage:
//   node scripts/adapters/usgs-seismic.mjs <orderId> <attesterSetId> <observedHeight> [feedUrl]
// It does not sign: attesters sign the v2 message with their own keys, outside this script.
// Source: U.S. Geological Survey, Earthquake Hazards Program (public domain).
import { createHash } from "node:crypto";

const [orderId, attesterSetId, height, url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson"] = process.argv.slice(2);
if (!orderId || !attesterSetId || !/^\d+$/.test(height ?? "")) {
  console.error("usage: usgs-seismic.mjs <orderId> <attesterSetId> <observedHeight> [feedUrl]");
  process.exit(2);
}
const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
if (!res.ok) { console.error(`source unavailable: HTTP ${res.status}`); process.exit(1); }
const bytes = Buffer.from(await res.arrayBuffer());
const body = { version: 2, sourceId: url, dataHash: createHash("sha256").update(bytes).digest("hex"), observedHeight: Number(height), orderId, attesterSetId };
console.log(JSON.stringify(body, null, 2));
