# Source adapters (off-node)

Code here fetches public sources and prepares an evidence statement body for
attesters to sign. It runs on an attester's machine, **never** inside a node,
`src/`, or the ledger worker. `npm run check:adapters` (CI) fails if anything
under `src/` imports this directory.

Rules (docs/ORACLE.md, docs/EVIDENCE.md):
- No state transition reads a source; with every source down the ledger and
  the Marketplace behave identically (signed `onNoEvidence` outcome).
- Only the SHA-256 of the fetched bytes, the observed ledger height and the
  source id enter a statement. The data stays outside.
- Statements are signed in the v2 format (`UEP-EVIDENCE-STATEMENT-v2`), bound to
  the target ledger network id.
- Respect each source's licence and attribution (e.g. USGS public domain,
  GEOFON CC BY 4.0 with attribution). EMSC only with written permission.

## Adapters (0.5.83)

| File | Source | Use | Licence / attribution |
|---|---|---|---|
| `seismic.mjs`, `usgs-seismic.mjs` | USGS FDSN event | Phase 2.3 seismic claim (origin 1) | Public domain; "U.S. Geological Survey, Earthquake Hazards Program" |
| `seismic.mjs`, `geofon-seismic.mjs` | GEOFON FDSN event | Phase 2.3 seismic claim (origin 2) | CC BY 4.0; "GEOFON Data Centre, GFZ Helmholtz Centre Potsdam (CC BY 4.0)" |
| `lab-sources.mjs` | NOAA SWPC Kp / F10.7, JPL Horizons, CelesTrak, NASA DSN Now, Open-Meteo | Lab only, `UEP_LAB_SOURCES=1`; Open-Meteo non-commercial only | see `LAB_SOURCES` and `docs/ORACLE.md` |

Run with `node --experimental-strip-types` (the seismic adapter reuses
`canonicalEvidenceClaim` from `src/marketplace/evidence.ts`; the dependency only
goes from adapters to `src/`, never back). Tests: `npm run test:adapters`
(recorded fixtures in `fixtures/`, network disabled).
