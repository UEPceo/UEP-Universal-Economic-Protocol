#!/usr/bin/env -S node --experimental-strip-types
// Off-node GEOFON seismic adapter (0.5.83). Prints the unsigned attester output:
// source id, dataHash, canonical SEISMIC claim and claimHash (or claim null).
// Attesters sign the v2 statement with their own keys, outside this script.
// Source: GEOFON (GFZ Helmholtz Centre for Geosciences). Event products: CC BY 4.0 (https://geofon.gfz.de/eqinfo/faq/), attribution required.
// Waveforms are under different, network-specific licences and are NOT used by UEP.
// Usage: node --experimental-strip-types scripts/adapters/geofon-seismic.mjs '<query JSON>'
import { fetchSeismic } from "./seismic.mjs";
const q = JSON.parse(process.argv[2] ?? "null");
if (!q) { console.error("usage: geofon-seismic.mjs '{\"minMagnitudeTenths\":50,\"latMinMicro\":...,\"fromHeight\":..,\"toHeight\":..,\"fromMs\":..,\"toMs\":..}'"); process.exit(2); }
try { console.log(JSON.stringify(await fetchSeismic("GEOFON", q), null, 2)); } catch (e) { console.error(e.message); process.exit(1); }
