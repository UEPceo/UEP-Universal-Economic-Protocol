#!/usr/bin/env -S node --experimental-strip-types
// Off-node USGS seismic adapter (0.5.83). Prints the unsigned attester output:
// source id, dataHash, canonical SEISMIC claim and claimHash (or claim null).
// Attesters sign the v2 statement with their own keys, outside this script.
// Source: U.S. Geological Survey, Earthquake Hazards Program (public domain).
// Usage: node --experimental-strip-types scripts/adapters/usgs-seismic.mjs '<query JSON>'
import { fetchSeismic } from "./seismic.mjs";
const q = JSON.parse(process.argv[2] ?? "null");
if (!q) { console.error("usage: usgs-seismic.mjs '{\"minMagnitudeTenths\":50,\"latMinMicro\":...,\"fromHeight\":..,\"toHeight\":..,\"fromMs\":..,\"toMs\":..}'"); process.exit(2); }
try { console.log(JSON.stringify(await fetchSeismic("USGS", q), null, 2)); } catch (e) { console.error(e.message); process.exit(1); }
