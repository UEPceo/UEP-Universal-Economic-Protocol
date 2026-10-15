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
