# Remediation report — UEP 0.5.73

Date: 2026-10-11. Base input: `UEP-Universal-Economic-Protocol-0_5_72.tar.gz`.

## Changes made

1. Fixed the process-level consensus test to send `Content-Type: application/json` on `/propose`, matching the peer server's 0.5.72 media-type requirement.
2. Fixed the unsigned-peer test fixture to send valid JSON content type, so it reaches and tests the intended `401 PEER_AUTH` branch.
3. Added a separate regression test proving that a POST without JSON content type returns `415 UNSUPPORTED_MEDIA_TYPE`.
4. Bumped package version to 0.5.73 and synchronized `package-lock.json`, peer `/status` version and its assertion.
5. Capped Node's test-runner file concurrency at four in test scripts to reduce unbounded parallel child-process pressure in CI and local runs. This does not change protocol runtime behavior.
6. Moved the 20k-user synthetic load test from the default Marketplace unit-test glob to the explicit `npm run test:scale` path, so a load benchmark is not silently included in the routine suite. Added `test:consensus` explicitly to `test:core` after separating it from the Marketplace suite.
7. Rewrote the reproducibility guide to remove stale 0.5.3 counts presented as current 0.5.72 results, and to state explicit limitations and incomplete validation honestly.
8. Updated the roadmap and changelog to reflect what this remediation does and does not establish.

## Validation results observed

| Command | Result |
|---|---|
| `npm run check:version` | PASS — 0.5.73 synchronized |
| `npm run lint:determinism` | PASS — 158 files, 0 violations |
| `npm run check:snapshot-compat` | PASS — format 10; 4 migration steps from format 6; fixtures consistent |
| `npm run check:donation` | PASS |
| `npm run test:consensus` | PASS — 44/44 tests, Node.js 22.16.0 |
| `npm run test:settlement` | PASS — 20/20 |
| `npm run test:oracle` | PASS — 38/38 |
| `npm run test:category` | PASS — 24/24 |
| `npm test` | PASS — 516/516 tests across protocol, Marketplace, settlement, Oracle and category suites |
| `npm run test:marketplace` | PASS — 220/220, 14 suites |
| `npm run test:protocol` | PASS — 214/214 |

The standard `npm test` suite passes. The broader `test:core` / `test:all` sequence is not certified here: `test:poisoned-clock` and `simulate:20k` did not finish inside their available execution windows, and Node.js 24, Rust suites and ZK labs remain unverified. CI must rerun those before release.

## Remaining architecture blockers (not silently marked fixed)

- The current fixed peer/threshold harness is not a production BFT consensus protocol and has no full view-change/recovery design.
- Catch-up currently accepts a snapshot from one pinned peer. Pinning protects identity but does not constitute a quorum-certified history.
- Local economic API acceptance is not necessarily quorum-finalized network state. API response/status semantics need an explicit proposed/accepted/committed/finalized model, and direct submit must not be misrepresented as network finality.
- Experimental Groth16/ZK circuit and development proving setup are not production-grade privacy or validity guarantees.
- The previous tree's documentation reports a large TypeScript error backlog outside `src/node`; a clean typecheck was not established here.
- Public-network behavior, external security assessment, multi-operator recovery and production key ceremony remain unverified.

## Release posture

This is a remediation bundle for engineering/testnet use only. It is not a production release, does not authorize handling real value, and does not claim that all known architectural risks have been resolved. Keep the public testnet isolated from real funds and credentials.
